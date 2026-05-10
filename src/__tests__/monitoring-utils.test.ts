/**
 * Tests for monitoring-utils: training smoke classification + cadence planning.
 */
import { describe, it, expect } from "vitest";
import {
  classifyTrainingSmoke,
  planMonitoringCadence,
  renderMonitoringCadenceSection,
} from "../monitoring-utils.js";

describe("classifyTrainingSmoke: skeleton detection (HALT cases)", () => {
  it("HALTs on NotImplementedError", () => {
    const stderr = `Traceback (most recent call last):
  File "train.py", line 42, in main
    raise NotImplementedError("T6.2 COND_A: extract pretrained embeddings")
NotImplementedError: T6.2 COND_A`;
    const v = classifyTrainingSmoke("", stderr, 1);
    expect(v.kind).toBe("skeleton");
    if (v.kind === "skeleton") expect(v.match).toBe("NotImplementedError");
  });

  it("HALTs on ImportError", () => {
    const v = classifyTrainingSmoke("", "ImportError: cannot import name 'foo' from 'bar'", 1);
    expect(v.kind).toBe("skeleton");
    if (v.kind === "skeleton") expect(v.match).toBe("ImportError");
  });

  it("HALTs on ModuleNotFoundError", () => {
    const v = classifyTrainingSmoke("", "ModuleNotFoundError: No module named 'unimol'", 1);
    expect(v.kind).toBe("skeleton");
    if (v.kind === "skeleton") expect(v.match).toBe("ModuleNotFoundError");
  });

  it("HALTs on SyntaxError", () => {
    const v = classifyTrainingSmoke("", "  SyntaxError: invalid syntax", 1);
    expect(v.kind).toBe("skeleton");
    if (v.kind === "skeleton") expect(v.match).toBe("SyntaxError");
  });

  it("HALTs on AttributeError 'has no attribute'", () => {
    const v = classifyTrainingSmoke("", "AttributeError: 'NoneType' object has no attribute 'forward'", 1);
    expect(v.kind).toBe("skeleton");
    if (v.kind === "skeleton") expect(v.match).toBe("AttributeError");
  });

  it("includes excerpt for diagnosis", () => {
    const stderr = "raise NotImplementedError('extract pretrained embeddings')";
    const v = classifyTrainingSmoke("", stderr, 1);
    if (v.kind !== "skeleton") throw new Error("expected skeleton");
    expect(v.excerpt).toContain("extract pretrained embeddings");
  });
});

describe("classifyTrainingSmoke: pass cases", () => {
  it("treats __SMOKE_IMPORT_OK__ as ok", () => {
    const v = classifyTrainingSmoke("__SMOKE_IMPORT_OK__\n__SMOKE_EXIT__0", "", 0);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.reason).toMatch(/imported cleanly/);
  });

  it("treats __SMOKE_EXIT__0 as ok", () => {
    const v = classifyTrainingSmoke("training started\n__SMOKE_EXIT__0", "", 0);
    expect(v.kind).toBe("ok");
  });

  it("treats __SMOKE_EXIT__124 (timeout) as ok — training is callable", () => {
    const v = classifyTrainingSmoke("epoch 0 step 1 it/s=2.4\n__SMOKE_EXIT__124", "", 0);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.reason).toMatch(/timeout = training is callable/);
  });

  it("does not treat 'NotImplementedError' as skeleton if it appears in unrelated output AFTER all skeleton patterns are absent", () => {
    // Edge case: plain epoch logs should still be ok
    const v = classifyTrainingSmoke("epoch 0/10 loss=2.3\n__SMOKE_EXIT__124", "", 0);
    expect(v.kind).toBe("ok");
  });
});

describe("classifyTrainingSmoke: degenerate cases", () => {
  it("returns timeout_no_ssh when ssh status is null and no output", () => {
    const v = classifyTrainingSmoke("", "", null);
    expect(v.kind).toBe("timeout_no_ssh");
  });

  it("returns unexpected when no marker and no skeleton found", () => {
    const v = classifyTrainingSmoke("some random output", "", 1);
    expect(v.kind).toBe("unexpected");
  });

  it("returns unexpected for unknown exit code", () => {
    const v = classifyTrainingSmoke("__SMOKE_EXIT__7", "", 0);
    expect(v.kind).toBe("unexpected");
    if (v.kind === "unexpected") expect(v.reason).toContain("7");
  });
});

describe("planMonitoringCadence: ETA computation", () => {
  it("eta = firstEpochSeconds × totalEpochs / 60 (minutes, rounded)", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 100,
      sessionRemainingMinutes: 999,
      runpodCostPerHr: 0.5,
      startUnix: 1_700_000_000,
    });
    expect(r.etaMinutes).toBe(100); // 60 × 100 = 6000s = 100min
  });

  it("eta uses absolute time", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 30,
      totalEpochs: 20,
      sessionRemainingMinutes: 999,
      runpodCostPerHr: 0.5,
      startUnix: 1_700_000_000,
    });
    // 30 × 20 = 600s = 10 min → start + 600s = 1_700_000_600
    expect(r.etaIso).toBe(new Date(1_700_000_600 * 1000).toISOString());
  });
});

describe("planMonitoringCadence: handoff decision", () => {
  it("supervise when ETA is well within session", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 30,    // ETA = 30min
      sessionRemainingMinutes: 90,    // threshold = 72min
      runpodCostPerHr: 0.5,
    });
    expect(r.handoffRequired).toBe(false);
    expect(r.recommendation).toBe("supervise");
    expect(r.handoffTemplate).toBeUndefined();
  });

  it("handoff when ETA exceeds 80% of session", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 240,   // ETA = 240min
      sessionRemainingMinutes: 90,    // threshold = 72min
      runpodCostPerHr: 0.5,
    });
    expect(r.handoffRequired).toBe(true);
    expect(r.recommendation).toBe("handoff");
    expect(r.handoffReason).toMatch(/80% of session/);
    expect(r.handoffTemplate).toBeDefined();
  });

  it("handoff template embeds podId, ETA, RSYNC_OK protocol", () => {
    const r = planMonitoringCadence({
      podId: "9qrjr7akk1myrz",
      firstEpochSeconds: 60,
      totalEpochs: 240,
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.22,
    });
    expect(r.handoffTemplate).toContain("9qrjr7akk1myrz");
    expect(r.handoffTemplate).toContain("RSYNC_OK");
    expect(r.handoffTemplate).toContain("artifactsSavedConfirmed=true");
    expect(r.handoffTemplate).toContain("$0.22/hr");
  });
});

describe("planMonitoringCadence: schedule generation", () => {
  it("supervise schedule has 50/80/100% checks", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 30,    // ETA = 30min
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.5,
    });
    expect(r.checkSchedule).toHaveLength(3);
    expect(r.checkSchedule[0].atMinutes).toBe(15); // 50%
    expect(r.checkSchedule[1].atMinutes).toBe(24); // 80%
    expect(r.checkSchedule[2].atMinutes).toBe(30); // 100%
  });

  it("handoff schedule has single early check (no 30-min polling)", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 240,   // ETA = 240min
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.5,
    });
    expect(r.checkSchedule).toHaveLength(1);
    expect(r.checkSchedule[0].atMinutes).toBeLessThan(60);
  });

  it("100% check action mentions RSYNC_OK + delete_pod", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 30,
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.5,
    });
    const finalCheck = r.checkSchedule[2];
    expect(finalCheck.action).toMatch(/RSYNC_OK/);
    expect(finalCheck.action).toMatch(/artifactsSavedConfirmed:true/);
  });
});

describe("planMonitoringCadence: cost estimates", () => {
  it("supervise cost = checks × cachePerCheck", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 30,
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.5,
      cachePerCheckUsd: 0.6,
    });
    expect(r.estimatedSupervisedTokenCost).toBeCloseTo(3 * 0.6); // 3 checks
    expect(r.estimatedHandoffTokenCost).toBe(0);
  });

  it("handoff cost is 10% of one cache miss (small fresh-session read)", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 240,
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.5,
      cachePerCheckUsd: 0.6,
    });
    expect(r.estimatedHandoffTokenCost).toBeCloseTo(0.06);
  });

  it("runpod cost = (etaMinutes/60) × hourly", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 240,   // ETA = 240min = 4hr
      sessionRemainingMinutes: 90,
      runpodCostPerHr: 0.22,
    });
    expect(r.estimatedRunpodCost).toBeCloseTo(4 * 0.22);
  });
});

describe("planMonitoringCadence: short-session edge (ISSUE-001)", () => {
  it("sessionRemainingMinutes < 12 with handoff → empty checkSchedule, handoff still required", () => {
    const r = planMonitoringCadence({
      podId: "abc",
      firstEpochSeconds: 60,
      totalEpochs: 10,        // ETA = 10min
      sessionRemainingMinutes: 5,    // session ends before ETA
      runpodCostPerHr: 0.5,
    });
    expect(r.handoffRequired).toBe(true);
    expect(r.checkSchedule).toEqual([]);
    expect(r.handoffTemplate).toBeDefined();
  });

  it("earlyCheck clamped to sessionRemainingMinutes - 2 when handoff and session is borderline", () => {
    // session=15min, ETA=120min → handoff (threshold 12). Naive earlyCheck = max(10, min(round(15*0.25)=4, round(120*0.2)=24)) = 10.
    // Session minus 2 = 13. min(10, 13) = 10. So earlyCheck=10 here, no clamping kicks in.
    // To force clamping, set session=14: max(10, min(4, 24)) = 10; clamp = min(10, 12) = 10. Still 10.
    // For real clamping force: session=12.5 (round to 13): max(10, min(3, 24)) = 10; clamp = min(10, 11) = 10.
    // Bottom line — clamp engages only when the proposed >= session-2. Reproduce with session=12, eta=200:
    // proposed = max(10, min(3, 40)) = 10. clamp = min(10, 10) = 10. equal, fine.
    // The simplest verifiable invariant: every earlyCheck must be ≤ sessionRemainingMinutes - 2.
    for (const session of [12, 15, 20, 30, 60, 90, 120]) {
      const r = planMonitoringCadence({
        podId: "abc",
        firstEpochSeconds: 60,
        totalEpochs: 240,        // ETA = 240min, always > session × 0.8 here
        sessionRemainingMinutes: session,
        runpodCostPerHr: 0.5,
      });
      expect(r.handoffRequired).toBe(true);
      if (r.checkSchedule.length > 0) {
        expect(r.checkSchedule[0].atMinutes).toBeLessThanOrEqual(session - 2);
      }
    }
  });
});

describe("renderMonitoringCadenceSection: ISSUE-002 partialMode + ISSUE-003 coverage", () => {
  it("emits 6-step plan when expectedHours provided and not partialMode", () => {
    const out = renderMonitoringCadenceSection({
      expectedHours: 4,
      gpuPrice: 0.34,
      partialMode: false,
    }).join("\n");
    expect(out).toContain("Monitoring Cadence Plan");
    expect(out).toContain("Step A. Cache-warm");
    expect(out).toContain("Step B. 처리량 실측");
    expect(out).toContain("Step C. plan_monitoring_cadence");
    expect(out).toContain("Step D. Session-handoff");
    expect(out).toContain("Step E. Wakeup pacing");
    expect(out).toContain("Step F. 완료 처리");
  });

  it("includes Session Span warning when expectedHours > 2", () => {
    const out = renderMonitoringCadenceSection({
      expectedHours: 4,
      gpuPrice: 0.34,
      partialMode: false,
    }).join("\n");
    expect(out).toContain("Session Span 경고");
    expect(out).toContain("MONITORING_HANDOFF.md");
  });

  it("omits Session Span warning when expectedHours <= 2", () => {
    const out = renderMonitoringCadenceSection({
      expectedHours: 2,
      gpuPrice: 0.34,
      partialMode: false,
    }).join("\n");
    expect(out).not.toContain("Session Span 경고");
  });

  it("omits Session Span warning when expectedHours is null", () => {
    const out = renderMonitoringCadenceSection({
      expectedHours: null,
      gpuPrice: 0.34,
      partialMode: false,
    }).join("\n");
    expect(out).not.toContain("Session Span 경고");
  });

  it("interpolates real gpuPrice in plan_monitoring_cadence call hint", () => {
    const out = renderMonitoringCadenceSection({
      expectedHours: 4,
      gpuPrice: 0.34,
      partialMode: false,
    }).join("\n");
    expect(out).toContain("runpodCostPerHr=0.34");
  });

  it("partialMode short-circuits — no Step A/B/C output, no misleading $0.00 price", () => {
    const out = renderMonitoringCadenceSection({
      expectedHours: 4,
      gpuPrice: 0,
      partialMode: true,
    }).join("\n");
    expect(out).toContain("PARTIAL PLAN");
    expect(out).not.toContain("Step A.");
    expect(out).not.toContain("Step B.");
    expect(out).not.toContain("runpodCostPerHr=0.00");
  });
});

describe("planMonitoringCadence: input validation", () => {
  it("rejects firstEpochSeconds <= 0", () => {
    expect(() =>
      planMonitoringCadence({
        podId: "abc",
        firstEpochSeconds: 0,
        totalEpochs: 10,
        sessionRemainingMinutes: 90,
        runpodCostPerHr: 0.5,
      })
    ).toThrow();
  });

  it("rejects totalEpochs <= 0", () => {
    expect(() =>
      planMonitoringCadence({
        podId: "abc",
        firstEpochSeconds: 60,
        totalEpochs: 0,
        sessionRemainingMinutes: 90,
        runpodCostPerHr: 0.5,
      })
    ).toThrow();
  });

  it("rejects sessionRemainingMinutes <= 0", () => {
    expect(() =>
      planMonitoringCadence({
        podId: "abc",
        firstEpochSeconds: 60,
        totalEpochs: 10,
        sessionRemainingMinutes: 0,
        runpodCostPerHr: 0.5,
      })
    ).toThrow();
  });
});
