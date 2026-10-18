import { expect, test } from 'bun:test';
import { brokerRestart } from '../helpers/broker-restart';

test('durability acceptance: pending request and both published eventIds survive broker restart', async () => {
  const report = await brokerRestart(true);
  expect(report.volumeMarkerSurvived).toBe(true);
  expect({ requestSurvived: report.requestSurvived, eventIds: report.survivingPublishedEventIds.sort() })
    .toEqual({ requestSurvived: true, eventIds: report.expectedPublishedEventIds.sort() });
}, 120000);
