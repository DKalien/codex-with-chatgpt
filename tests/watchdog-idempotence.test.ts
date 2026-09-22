import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WAKE_WATCHDOG_ALARM_NAME,
  WAKE_WATCHDOG_PERIOD_MINUTES,
  createWakeWatchdogController,
  wakeWatchdogAlarmMatches,
  wakeWatchdogEligible,
} from "../browser-companion/wake-watchdog.js";

function fakeAlarms(initial: Record<string, unknown> | null = null) {
  let current = initial;
  const alarms = {
    get: vi.fn(async (name: string) => name === WAKE_WATCHDOG_ALARM_NAME ? current : undefined),
    create: vi.fn(async (name: string, info: Record<string, unknown>) => {
      current = { name, ...info, scheduledTime: 123 };
    }),
    clear: vi.fn(async (name: string) => {
      if (name === WAKE_WATCHDOG_ALARM_NAME) current = null;
      return true;
    }),
  };
  return { alarms, current: () => current };
}

describe("wake watchdog alarm synchronization", () => {
  it("does not recreate or clear on repeated/concurrent same-state syncs", async () => {
    const fake = fakeAlarms();
    const controller = createWakeWatchdogController(() => fake.alarms);

    await Promise.all([
      controller.sync(true),
      controller.sync(true),
      controller.sync(true),
    ]);
    const installed = fake.current();
    expect(fake.alarms.get).toHaveBeenCalledTimes(1);
    expect(fake.alarms.create).toHaveBeenCalledTimes(1);
    expect(fake.alarms.clear).not.toHaveBeenCalled();

    await controller.sync(true);
    expect(fake.alarms.get).toHaveBeenCalledTimes(1);
    expect(fake.alarms.create).toHaveBeenCalledTimes(1);
    expect(fake.current()).toBe(installed);

    await controller.sync(false);
    await controller.sync(false);
    expect(fake.alarms.clear).toHaveBeenCalledTimes(1);
  });

  it("checks existing alarm after restart and creates only when missing or mismatched", async () => {
    const existing = {
      name: WAKE_WATCHDOG_ALARM_NAME,
      periodInMinutes: WAKE_WATCHDOG_PERIOD_MINUTES,
      scheduledTime: 456,
    };
    const present = fakeAlarms(existing);
    await createWakeWatchdogController(() => present.alarms).sync(true);
    expect(present.alarms.get).toHaveBeenCalledTimes(1);
    expect(present.alarms.create).not.toHaveBeenCalled();
    expect(present.current()).toBe(existing);

    for (const initial of [null, { ...existing, periodInMinutes: 2 }]) {
      const missing = fakeAlarms(initial);
      await createWakeWatchdogController(() => missing.alarms).sync(true);
      expect(missing.alarms.get).toHaveBeenCalledTimes(1);
      expect(missing.alarms.create).toHaveBeenCalledTimes(1);
      expect(missing.current()).toMatchObject({
        name: WAKE_WATCHDOG_ALARM_NAME,
        periodInMinutes: WAKE_WATCHDOG_PERIOD_MINUTES,
      });
    }
  });

  it("clears a stale alarm when a restarted worker hydrates ineligible state", async () => {
    const existing = {
      name: WAKE_WATCHDOG_ALARM_NAME,
      periodInMinutes: WAKE_WATCHDOG_PERIOD_MINUTES,
      scheduledTime: 789,
    };
    const fake = fakeAlarms(existing);
    const controller = createWakeWatchdogController(() => fake.alarms);

    const result = await controller.sync(false);

    expect(result).toMatchObject({ ok: true, action: "clear", desired: false });
    expect(fake.alarms.get).toHaveBeenCalledTimes(1);
    expect(fake.alarms.clear).toHaveBeenCalledTimes(1);
    expect(fake.current()).toBeNull();
  });

  it("keeps active journal recovery eligible and ignores unrelated alarm names", () => {
    expect(wakeWatchdogEligible({
      storageProtected: true,
      transport: { bridgeOrigin: "https://bridge.example.test", authStale: false },
      autonomyMode: "off",
      journalState: "RESERVED",
    })).toBe(true);
    expect(wakeWatchdogAlarmMatches({
      name: "unrelated.alarm",
      periodInMinutes: WAKE_WATCHDOG_PERIOD_MINUTES,
    })).toBe(false);

    const sw = fs.readFileSync(path.join(process.cwd(), "browser-companion", "service-worker.js"), "utf8");
    const start = sw.indexOf("async function handleWakeWatchdogAlarm");
    const end = sw.indexOf("/** Ask only the known active owner tab", start);
    const handler = sw.slice(start, end);
    expect(handler).toContain("alarm.name !== WAKE_WATCHDOG_ALARM_NAME");
    expect(handler).toContain("discoveryOnly: true");
    expect(handler).not.toContain("maybeRunAutonomyTick");
  });
});
