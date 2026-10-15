import { MessageBody, ConnectedSocket, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
})
export class AppGateway {
  @SubscribeMessage('diagnostic:ping')
  handleDiagnosticPing(
    @MessageBody() payload: { sentAt?: string } | undefined,
    @ConnectedSocket() client: Socket,
  ): void {
    client.emit('diagnostic:pong', {
      serverTime: new Date().toISOString(),
      clientSentAt: payload?.sentAt ?? null,
    });
  }
}
