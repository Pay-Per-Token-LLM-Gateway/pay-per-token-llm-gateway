import { EscrowController } from './escrow.controller';
import type { CreditEscrowService } from './credit-escrow.service';

const ADDRESS = 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL';

describe('EscrowController', () => {
  it('returns only the authenticated wallet balance', async () => {
    const service = {
      isConfigured: jest.fn().mockReturnValue(true),
      readBalance: jest.fn().mockResolvedValue(12345n),
    } as unknown as CreditEscrowService;
    const controller = new EscrowController(service);

    const request = { authenticatedAddress: ADDRESS } as Parameters<
      typeof controller.getBalance
    >[0];
    await expect(controller.getBalance(request)).resolves.toEqual({
      address: ADDRESS,
      configured: true,
      balance: '12345',
    });
    expect(service.readBalance).toHaveBeenCalledWith(ADDRESS);
  });

  it('does not accept a caller-supplied address for usage history', async () => {
    const service = {
      readUsage: jest.fn().mockResolvedValue([]),
    } as unknown as CreditEscrowService;
    const controller = new EscrowController(service);

    const request = { authenticatedAddress: ADDRESS } as Parameters<typeof controller.getUsage>[0];
    await controller.getUsage(request, '0', '25');
    expect(service.readUsage).toHaveBeenCalledWith(ADDRESS, 0, 25);
  });
});
