import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      status: 'ok',
      service: 'friend-feud-api',
      serverTime: new Date().toISOString(),
    };
  }
}
