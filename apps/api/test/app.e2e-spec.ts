import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { io } from 'socket.io-client';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
        expect(body.service).toBe('friend-feud-api');
      });
  });

  it('accepts a Socket.IO diagnostic ping', async () => {
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('No HTTP address available');

    const socket = io(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
      reconnection: false,
    });

    try {
      const response = await new Promise<{ serverTime: string }>(
        (resolve, reject) => {
          socket.once('connect_error', reject);
          socket.once('diagnostic:pong', resolve);
          socket.once('connect', () =>
            socket.emit('diagnostic:ping', { sentAt: new Date().toISOString() }),
          );
        },
      );

      expect(response.serverTime).toEqual(expect.any(String));
    } finally {
      socket.close();
    }
  });

  afterEach(async () => {
    await app.close();
  });
});
