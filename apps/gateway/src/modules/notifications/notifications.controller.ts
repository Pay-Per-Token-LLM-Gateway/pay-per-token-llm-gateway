import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get paginated in-app notifications for the authenticated wallet' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'unreadOnly', required: false })
  async getNotifications(
    @CurrentWallet() wallet: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const safePage = Math.max(1, parseInt(page || '1', 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit || '50', 10) || 50));
    const filterUnread = unreadOnly === 'true';

    return this.notificationsService.getNotifications(wallet, {
      page: safePage,
      limit: safeLimit,
      unreadOnly: filterUnread,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count for the authenticated wallet' })
  async getUnreadCount(@CurrentWallet() wallet: string) {
    const count = await this.notificationsService.getUnreadCount(wallet);
    return { unread: count };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markRead(@Param('id') id: string) {
    const success = await this.notificationsService.markRead(id);
    if (!success) {
      throw new BadRequestException('Notification not found');
    }
    return { success: true };
  }
}
