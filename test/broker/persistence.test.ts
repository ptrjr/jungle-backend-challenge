import { expect, test } from 'bun:test';
import { brokerRestart } from '../helpers/broker-restart';

for (const explicitSnapshots of [false, true]) {
  test(`diagnostic: isolated broker restart and pending outbox recovery (explicit snapshots: ${explicitSnapshots})`, async () => {
    const report = await brokerRestart(explicitSnapshots);
    expect(report.volumeMarkerSurvived).toBe(true);
    expect(report.recoveredPendingEvents).toBe(2);
    expect(report.alreadyPublishedEventsReplayed).toBe(0);
    expect(report.consistent).toBe(true);
  }, 120000);
}
