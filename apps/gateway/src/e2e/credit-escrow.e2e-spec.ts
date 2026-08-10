import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EscrowController } from '../modules/escrow/escrow.controller';
import { CreditEscrowService } from '../modules/escrow/credit-escrow.service';
import { AuthGuard } from '../modules/auth/auth.guard';

const ADDRESS = 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL';

describe('Credit escrow HTTP endpoints', () => {
  let app: INestApplication;
  const escrowService = {
    isConfigured: jest.fn().mockReturnValue(true),
    readBalance: jest.fn().mockResolvedValue(987654n),
    readUsage: jest
      .fn()
      .mockResolvedValue([
        { user: ADDRESS, amount: '250', quoteId: 'quote-1', timestamp: 1710000000 },
      ]),
  };

  beforeAll(async () => {
    const moduleBuilder = Test.createTestingModule({
      controllers: [EscrowController],
      providers: [{ provide: CreditEscrowService, useValue: escrowService }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          context.switchToHttp().getRequest().authenticatedAddress = ADDRESS;
          return true;
        },
      });
    const moduleRef = await moduleBuilder.compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /api/v1/escrow/balances returns the authenticated wallet only', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/escrow/balances')
      .set('Authorization', 'Bearer test-token')
      .expect(200)
      .expect({ address: ADDRESS, configured: true, balance: '987654' });
  });

  it('GET /api/v1/escrow/usage returns usage for the authenticated wallet', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/escrow/usage?offset=0&limit=10')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(response.body).toEqual({
      address: ADDRESS,
      usage: [{ user: ADDRESS, amount: '250', quoteId: 'quote-1', timestamp: 1710000000 }],
    });
  });
});
