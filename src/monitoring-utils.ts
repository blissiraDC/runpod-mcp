/**
 * Pure utility functions for preflight smoke classification and monitoring cadence planning.
 * Extracted for testability — no SSH / no IO.
 */

// ── Training smoke classifier ─────────────────────────────────────────────

const SKELETON_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /NotImplementedError/, label: "NotImplementedError" },
  { re: /^\s*ImportError\b/m, label: "ImportError" },
  { re: /ModuleNotFoundError/, label: "ModuleNotFoundError" },
  { re: /^\s*SyntaxError\b/m, label: "SyntaxError" },
  { re: /^\s*AttributeError:.*has no attribute/m, label: "AttributeError" },
];

export type SmokeVerdict =
  | { kind: "skeleton"; match: string; excerpt: string }
  | { kind: "ok"; reason: string }
  | { kind: "timeout_no_ssh" }
  | { kind: "unexpected"; reason: string };

/**
 * Classify the result of a training smoke command.
 *
 * Decision rules:
 *   - Any skeleton pattern present in stdout/stderr → skeleton (HALT)
 *   - __SMOKE_IMPORT_OK__ present → ok (clean import)
 *   - __SMOKE_EXIT__0 present → ok (clean exit)
 *   - __SMOKE_EXIT__124 present (no skeleton hit) → ok (training ran 30s without crashing — good signal)
 *   - sshStatus null (SSH-level timeout) → timeout_no_ssh
 *   - otherwise → unexpected
 */
export function classifyTrainingSmoke(
  stdout: string,
  stderr: string,
  sshStatus: number | null
): SmokeVerdict {
  if (sshStatus === null && !stdout && !stderr) {
    return { kind: "timeout_no_ssh" };
  }
  const combined = `${stdout}\n${stderr}`;
  for (const p of SKELETON_PATTERNS) {
    if (p.re.test(combined)) {
      const lines = combined.split("\n");
      const hit = lines.find((l) => p.re.test(l)) ?? p.label;
      return { kind: "skeleton", match: p.label, excerpt: hit.trim() };
    }
  }
  if (combined.includes("__SMOKE_IMPORT_OK__")) {
    return { kind: "ok", reason: "Module imported cleanly (no top-level skeleton)" };
  }
  const exitMatch = combined.match(/__SMOKE_EXIT__(\d+)/);
  if (exitMatch) {
    const code = exitMatch[1];
    if (code === "0") return { kind: "ok", reason: "Smoke command exited 0" };
    if (code === "124") {
      return { kind: "ok", reason: "Smoke ran for 30s without skeleton errors (timeout = training is callable)" };
    }
    return { kind: "unexpected", reason: `exit ${code}` };
  }
  if (sshStatus === null) return { kind: "timeout_no_ssh" };
  return { kind: "unexpected", reason: `ssh_status=${sshStatus}, no smoke marker found` };
}

// ── Monitoring cadence planner ────────────────────────────────────────────

export interface CadenceInput {
  podId: string;
  firstEpochSeconds: number;
  totalEpochs: number;
  sessionRemainingMinutes: number;
  cachePerCheckUsd?: number;     // default 0.6 (200k tokens × $3/MTok)
  runpodCostPerHr: number;
  startUnix?: number;            // default now
}

export interface CadenceCheck {
  atMinutes: number;             // minutes from startUnix
  atIso: string;                 // absolute UTC time
  fraction: number;              // 0..1 of ETA
  action: string;
}

export interface CadenceResult {
  etaMinutes: number;
  etaIso: string;
  handoffRequired: boolean;
  handoffReason?: string;
  checkSchedule: CadenceCheck[];
  estimatedSupervisedTokenCost: number;
  estimatedHandoffTokenCost: number;
  estimatedRunpodCost: number;
  recommendation: "supervise" | "handoff";
  handoffTemplate?: string;
}

/**
 * Decide monitoring cadence from measured throughput.
 *
 * Core rules:
 *   - eta = firstEpochSeconds × totalEpochs / 60
 *   - handoff required when eta > sessionRemainingMinutes × 0.8
 *     (rationale: leaves no margin to react to issues; cache miss × N >> $0.5 fresh-session cost)
 *   - supervise schedule: 50%, 80%, 100% of ETA (3 checks)
 *   - handoff schedule: single early sanity check at 25% of remaining session, then handoff doc
 */
export function planMonitoringCadence(input: CadenceInput): CadenceResult {
  const cachePerCheck = input.cachePerCheckUsd ?? 0.6;
  const startUnix = input.startUnix ?? Math.floor(Date.now() / 1000);

  if (input.firstEpochSeconds <= 0 || input.totalEpochs <= 0) {
    throw new Error("firstEpochSeconds and totalEpochs must be positive");
  }
  if (input.sessionRemainingMinutes <= 0) {
    throw new Error("sessionRemainingMinutes must be positive");
  }

  const etaMinutes = Math.round((input.firstEpochSeconds * input.totalEpochs) / 60);
  const etaIso = new Date((startUnix + etaMinutes * 60) * 1000).toISOString();

  const sessionThreshold = input.sessionRemainingMinutes * 0.8;
  const handoffRequired = etaMinutes > sessionThreshold;

  const toIso = (mins: number) => new Date((startUnix + mins * 60) * 1000).toISOString();

  let checks: CadenceCheck[];
  let handoffTemplate: string | undefined;
  let handoffReason: string | undefined;

  if (handoffRequired) {
    // Short-session guard: if there's no realistic window for an early check
    // (sessionRemainingMinutes < 12), skip the check entirely and hand off immediately.
    // Otherwise compute earlyCheck and clamp so it never exceeds sessionRemainingMinutes - 2.
    if (input.sessionRemainingMinutes < 12) {
      checks = [];
    } else {
      const proposed = Math.max(
        10,
        Math.min(Math.round(input.sessionRemainingMinutes * 0.25), Math.round(etaMinutes * 0.2))
      );
      const earlyCheckMin = Math.min(proposed, input.sessionRemainingMinutes - 2);
      checks = [
        {
          atMinutes: earlyCheckMin,
          atIso: toIso(earlyCheckMin),
          fraction: earlyCheckMin / etaMinutes,
          action: "gpu_sample_burst — last cache-warm sanity check before handoff",
        },
      ];
    }
    handoffReason =
      `ETA ${etaMinutes}min exceeds 80% of session window (${input.sessionRemainingMinutes}min × 0.8 = ${sessionThreshold.toFixed(0)}min). ` +
      `Token cost of supervising ≈ ${Math.ceil(etaMinutes / 30)} cache-misses × $${cachePerCheck.toFixed(2)} would dominate runpod cost.`;
    handoffTemplate = renderHandoffTemplate({
      podId: input.podId,
      etaIso,
      etaMinutes,
      runpodCostPerHr: input.runpodCostPerHr,
    });
  } else {
    checks = [0.5, 0.8, 1.0].map((frac) => {
      const at = Math.round(etaMinutes * frac);
      return {
        atMinutes: at,
        atIso: toIso(at),
        fraction: frac,
        action:
          frac < 0.99
            ? `gpu_health_check — verify still ${frac === 0.5 ? "running healthily" : "approaching completion"}`
            : "rsync /root/outputs → /workspace/outputs (RSYNC_OK), then delete_pod(artifactsSavedConfirmed:true)",
      };
    });
  }

  const estimatedSupervisedTokenCost = checks.length * cachePerCheck;
  const estimatedHandoffTokenCost = handoffRequired ? cachePerCheck * 0.1 : 0; // ~5k handoff doc in fresh session
  const estimatedRunpodCost = (etaMinutes / 60) * input.runpodCostPerHr;

  return {
    etaMinutes,
    etaIso,
    handoffRequired,
    handoffReason,
    checkSchedule: checks,
    estimatedSupervisedTokenCost,
    estimatedHandoffTokenCost,
    estimatedRunpodCost,
    recommendation: handoffRequired ? "handoff" : "supervise",
    handoffTemplate,
  };
}

// ── Cadence Plan section renderer (used by plan_gpu_job) ─────────────────

export interface CadenceSectionInput {
  expectedHours: number | null;
  gpuPrice: number;
  partialMode: boolean;
}

/**
 * Render the "Monitoring Cadence Plan" section that plan_gpu_job appends to its output.
 * Extracted as a pure function so plan_gpu_job's text rendering is unit-testable AND so
 * partialMode (no GPU recommended → gpuPrice=0) can degrade cleanly instead of leaking
 * a misleading `runpodCostPerHr=0.00` literal.
 */
export function renderMonitoringCadenceSection(input: CadenceSectionInput): string[] {
  const lines: string[] = [];
  lines.push(``);
  lines.push(`### Monitoring Cadence Plan (필수 — 6단계, 임의 polling 금지)`);

  if (input.partialMode) {
    lines.push(``);
    lines.push(`⚠️ GPU 추천이 없는 PARTIAL PLAN 상태 — 적합한 GPU 확정 후 다시 \`plan_gpu_job\`을 호출해 cadence 섹션을 받으세요.`);
    return lines;
  }

  if (input.expectedHours != null && input.expectedHours > 2) {
    lines.push(``);
    lines.push(`⚠️ **Session Span 경고**: expectedHours=${input.expectedHours} > 2시간. 단일 conversation으로 supervise 비현실적 (cache miss × N = 토큰 비용 폭증).`);
    lines.push(`→ Step C에서 \`plan_monitoring_cadence\` 가 거의 항상 \`handoffRequired=true\` 반환할 것. MONITORING_HANDOFF.md 패턴을 처음부터 채택.`);
  }

  const priceLiteral = input.gpuPrice.toFixed(2);

  lines.push(``);
  lines.push(`**Step A. Cache-warm 검증 (T+0 ~ T+5min)** — 짧은 cache-warm 윈도우로 실행 정상 여부 확인`);
  lines.push(`- 훈련 launch 직후 60s 대기 → \`gpu_sample_burst(podId, samples=5, intervalSeconds=5)\``);
  lines.push(`- \`STABLE_OPTIMAL\` / \`IMPROVING\` → Step B 진행`);
  lines.push(`- \`CONSISTENTLY_IDLE\` → 즉시 중단. NotImplementedError / CPU fallback / 데이터 경로 오류 의심 → 로그 확인 + delete_pod`);
  lines.push(`- \`DEGRADING\` / \`VOLATILE\` → 로그 확인 후 결정`);
  lines.push(``);
  lines.push(`**Step B. 처리량 실측 (T+5min ~ T+10min)** — 1 epoch/step 실측 시간 확보`);
  lines.push(`- \`execute_ssh_command(podId, "tail -100 /workspace/log 2>/dev/null | grep -E 'epoch|step|it/s' | tail -5")\``);
  lines.push(`- 1 epoch (또는 step) 실측 시간 = X초, 총 epoch 수 = N`);
  lines.push(`- 측정 ETA = X × N / 60 (분)`);
  lines.push(`- expectedHours=${input.expectedHours ?? "unknown"}h vs 측정 ETA 비교 → ±30% 초과 시 plan/GPU 재검토`);
  lines.push(``);
  lines.push(`**Step C. plan_monitoring_cadence 호출 (T+10min)** — 머신리더블 스케줄 산출`);
  lines.push(`- \`plan_monitoring_cadence(podId="<id>", firstEpochSeconds=X, totalEpochs=N, sessionRemainingMinutes=<남은시간>, runpodCostPerHr=${priceLiteral})\``);
  lines.push(`- 출력: \`etaMinutes\`, \`handoffRequired\`, \`checkSchedule[]\`, \`estimatedSupervisedTokenCost\`, \`estimatedHandoffTokenCost\`, \`handoffTemplate\``);
  lines.push(`- ⚠️ **이 도구가 산출하는 스케줄을 그대로 따를 것. 30분 fixed polling 금지** (cache miss 누적 = $0.6/회 × N 비용 폭증)`);
  lines.push(``);
  lines.push(`**Step D. Session-handoff 분기**`);
  lines.push(`- \`handoffRequired=true\` → 즉시 \`MONITORING_HANDOFF.md\` 작성 (\`handoffTemplate\` 활용 — pod ID, ETA UTC, RSYNC_OK 명령 자동 채워짐)`);
  lines.push(`- 새 세션이 ETA 시점에만 재진입 → download + cleanup (200k context 재처리 비용 회피, ~$0.5에 해결)`);
  lines.push(`- \`handoffRequired=false\` → 직접 supervise (\`checkSchedule\`의 시각에만 체크)`);
  lines.push(``);
  lines.push(`**Step E. Wakeup pacing 규칙**`);
  lines.push(`- 다음 체크까지 < 4분 → 직접 대기 (cache 유지, sleep 270s 이하)`);
  lines.push(`- 4분 ~ 60분 → 다른 작업 후 \`ScheduleWakeup\` (cache miss 1회 감수)`);
  lines.push(`- 60분 + → handoff 전환 (Step D)`);
  lines.push(`- 절대 금지: 5분+ polling 루프 (cache miss 누적)`);
  lines.push(``);
  lines.push(`**Step F. 완료 처리**`);
  lines.push(`- (NV 있음) \`rsync -a /root/outputs/ /workspace/outputs/ && echo RSYNC_OK\` → RSYNC_OK 확인 후 \`delete_pod(artifactsSavedConfirmed: true)\``);
  lines.push(`- (NV 없음) \`download_files\` → 완료 확인 후 \`delete_pod(artifactsSavedConfirmed: true)\``);
  lines.push(`- 위 확인 없이 \`delete_pod\` 호출 금지 (아티팩트 손실)`);

  return lines;
}

function renderHandoffTemplate(args: {
  podId: string;
  etaIso: string;
  etaMinutes: number;
  runpodCostPerHr: number;
}): string {
  return [
    `# RunPod Monitoring Handoff`,
    ``,
    `- Pod ID: \`${args.podId}\``,
    `- ETA (UTC): \`${args.etaIso}\` (~${args.etaMinutes} min from launch)`,
    `- Cost rate: $${args.runpodCostPerHr.toFixed(2)}/hr (idle billing if not deleted promptly)`,
    ``,
    `## Resume protocol (new session, after ETA)`,
    `1. \`get_pod(podId="${args.podId}")\` — confirm status RUNNING and time elapsed > ETA`,
    `2. \`gpu_sample_burst(podId="${args.podId}", samples=3)\` — verify training has wound down (CONSISTENTLY_IDLE expected)`,
    `3. (NV present) \`execute_ssh_command(podId="${args.podId}", command="rsync -a /root/outputs/ /workspace/outputs/ && echo RSYNC_OK")\` — must see \`RSYNC_OK\` in stdout`,
    `4. (NV absent) \`download_files(podId="${args.podId}", remotePath="/workspace", localPath="./outputs/")\``,
    `5. \`delete_pod(podId="${args.podId}", artifactsSavedConfirmed=true)\` — only after step 3 or 4 confirmed`,
    ``,
    `## Failure handling`,
    `- If ETA elapsed and training still running: extend ETA by 30%, re-check via gpu_sample_burst`,
    `- If pod stopped/exited: read logs via \`execute_ssh_command(... "tail -200 /workspace/log")\` before deleting`,
    `- NEVER call \`delete_pod\` without confirming artifact persistence (rsync RSYNC_OK or download_files completion)`,
  ].join("\n");
}
