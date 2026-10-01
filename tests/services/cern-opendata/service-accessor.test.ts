/**
 * @fileoverview Tests for the process-wide service accessor: it throws until
 * initialized, then serves the instance `initCernOpenDataService` built.
 * @module tests/services/cern-opendata/service-accessor.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeService } from '../../fixtures/cern-opendata-harness.js';
import { docHit, jsonResponse, portalRoute } from '../../fixtures/cern-opendata-upstream.js';

const loadModule = () => import('@/services/cern-opendata/cern-opendata-service.js');

describe('service accessor', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws an actionable error before initialization', async () => {
    const { getCernOpenDataService } = await loadModule();
    expect(() => getCernOpenDataService()).toThrow(/not initialized.*initCernOpenDataService/);
  });

  it('serves the initialized instance, wired to the options it was given', async () => {
    const { getCernOpenDataService, initCernOpenDataService } = await loadModule();
    const { http } = makeService([
      portalRoute(/^\/api\/docs\/.+/, jsonResponse({ id: 'x', metadata: docHit.metadata })),
    ]);
    initCernOpenDataService({ fetch: http.fetch, userAgent: 'cern-opendata-mcp-server/1.2.3' });
    const service = getCernOpenDataService();
    expect(getCernOpenDataService()).toBe(service);

    await service.getDoc('x', service.startBudget(), createMockContext());
    expect(http.calls[0]?.request.headers.get('user-agent')).toBe('cern-opendata-mcp-server/1.2.3');
    service.dispose();
  });

  it('replaces the instance when initialized again', async () => {
    const { getCernOpenDataService, initCernOpenDataService } = await loadModule();
    initCernOpenDataService();
    const first = getCernOpenDataService();
    initCernOpenDataService();
    const second = getCernOpenDataService();
    expect(second).not.toBe(first);
    first.dispose();
    second.dispose();
  });
});
