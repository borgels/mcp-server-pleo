import { describe, expect, it } from 'vitest';
import { createPleoGateway, pleoGatewayTools } from '../src/gateway.js';

describe('Pleo gateway export', () => {
  it('exposes a curated read-first expense surface', () => {
    expect(pleoGatewayTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'check_connection',
      'search_employees',
      'list_export_items',
    ]));
    expect(pleoGatewayTools.every(tool => tool.riskLevel === 'read')).toBe(true);
  });

  it('passes workspace credentials to Pleo requests', async () => {
    const requests: Request[] = [];
    const gateway = createPleoGateway({
      apiKey: 'pleo-key',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });

    await gateway.callTool('check_connection');
    expect(requests[0]?.headers.get('Authorization')).toBe(`Basic ${Buffer.from('pleo-key:', 'utf8').toString('base64')}`);
  });
});
