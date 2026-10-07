import { MqService } from './mq.service';
import { ConfigService } from '@nestjs/config';

/**
 * 消费失败语义测试：为什么重要——
 * 消费失败（如 Neo4j/ES 不可用）若走 nack/重投会让毒消息无限阻塞队列，
 * 项目约定是「错误日志（含 docId）+ ack 丢弃」，本组用例固化该约定：
 * 任何人把 ack 改成 nack/重投、或删掉 JSON 解析兜底，测试必须变红。
 */
const mockChannel = {
  assertExchange: jest.fn().mockResolvedValue(undefined),
  assertQueue: jest.fn().mockResolvedValue(undefined),
  bindQueue: jest.fn().mockResolvedValue(undefined),
  consume: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
  ack: jest.fn(),
  nack: jest.fn(),
};
const mockConnection = {
  on: jest.fn(),
  createChannel: jest.fn(() => mockChannel),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('amqp-connection-manager', () => ({
  __esModule: true,
  default: { connect: jest.fn(() => mockConnection) },
}));

/** 模拟 broker 投递（content 与真实 ConsumeMessage 一致，其余字段消费逻辑不关心） */
const deliver = (payload: unknown) =>
  ({
    content: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  }) as never;

describe('MqService 消费失败语义（毒消息不阻塞队列）', () => {
  let svc: MqService;
  let handler: jest.Mock;
  let onMessage: (msg: unknown) => Promise<void>;

  beforeEach(async () => {
    jest.clearAllMocks();
    svc = new MqService({
      get: () => 'amqp://guest:guest@localhost:5672',
    } as unknown as ConfigService);
    await svc.onModuleInit();
    handler = jest.fn();
    await svc.consume('test.queue', handler);
    // 取最后一次注册的消费回调（queue, callback, options）
    onMessage = mockChannel.consume.mock.calls.at(-1)![1] as typeof onMessage;
  });

  it('消费失败：handler 抛错被吞掉（仅记日志），消息 ack 且绝不 nack/重投', async () => {
    handler.mockRejectedValueOnce(new Error('Neo4j ServiceUnavailable: 连接失败'));
    const msg = deliver({ docId: '7504813748293472256' });

    await expect(onMessage(msg)).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockChannel.ack).toHaveBeenCalledTimes(1);
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });

  it('消费成功：ack 一次', async () => {
    handler.mockResolvedValueOnce(undefined);
    const msg = deliver({ docId: '7504813748293472256' });

    await onMessage(msg);

    expect(mockChannel.ack).toHaveBeenCalledTimes(1);
    expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });

  it('非法 JSON 毒消息：直接 ack 丢弃，handler 不执行，队列不堵塞', async () => {
    await onMessage(deliver('not-json{{{'));

    expect(handler).not.toHaveBeenCalled();
    expect(mockChannel.ack).toHaveBeenCalledTimes(1);
    expect(mockChannel.nack).not.toHaveBeenCalled();
  });
});
