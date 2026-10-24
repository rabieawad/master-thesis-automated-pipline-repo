import enum
import gzip
import pickle
from collections.abc import Callable
from typing import Coroutine, Any

import aio_pika


class SerializedType(enum.Enum):
    PICKLE = b"\x00"
    PICKLE_GZIP = b"\x01"


def serialize(obj):
    data = pickle.dumps(obj)
    serialized_type = SerializedType.PICKLE.value
    if len(data) > 1e6:
        data = gzip.compress(data, compresslevel=1)  # light, but fast
        serialized_type = SerializedType.PICKLE_GZIP.value
    return serialized_type + data


def deserialize(msg):
    serialized_type, data = msg[0:1], msg[1:]
    if serialized_type == SerializedType.PICKLE.value:
        return pickle.loads(data)
    if serialized_type == SerializedType.PICKLE_GZIP.value:
        return pickle.loads(gzip.decompress(data))
    raise NotImplementedError(f"Unsupported SerializedType {serialized_type}")


async def robust_connect(amqp_uri, /, max_tries=10, interval=1):
    import asyncio
    import aio_pika, aiormq

    try:
        conn = await aio_pika.connect_robust(amqp_uri)
        return conn
    except aiormq.exceptions.AMQPConnectionError:
        max_tries -= 1
        if max_tries <= 0:
            raise
        await asyncio.sleep(interval)


async def publisher(
    amqp_uri,
    queue_name,
    generator,
    /,
    prefetch_count=1,
    max_length=None,
    ack_timeout_ms=None,
):
    import asyncio
    import aio_pika, aiormq

    conn = await robust_connect(amqp_uri)
    channel = await conn.channel()
    await channel.set_qos(prefetch_count=prefetch_count)

    # It is important that all applications, that use a queue, declare it in the same way
    queue_args = {}
    if max_length is not None:
        queue_args["x-max-length"] = max_length
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms
    queue = await channel.declare_queue(queue_name, arguments=queue_args)

    for message in generator():
        while True:
            try:
                await channel.default_exchange.publish(
                    aio_pika.Message(body=serialize(message)), routing_key=queue.name
                )
                break
            except (
                aio_pika.exceptions.DeliveryError,
                aiormq.exceptions.ChannelInvalidStateError,
                ConnectionResetError,
                ConnectionRefusedError,
                RuntimeError,
            ):
                await asyncio.sleep(0.5)

    await channel.close()
    await conn.close()


async def async_publisher(
    amqp_uri,
    queue_name,
    generator,
    /,
    prefetch_count=1,
    max_length=None,
    ack_timeout_ms=None,
):
    """
    Scaffold for producing items with an async function

    :param amqp_uri: URI to RabbitMQ
    :param queue_name: Name of output queue
    :param generator: Async generator function
    :param prefetch_count: Prefetch setting must match consumer side
    :param max_length: Max length setting must match consumer side
    :param ack_timeout_ms: Timeout setting must match consumer side
    :return: None
    """
    import asyncio
    import aio_pika, aiormq

    conn = await robust_connect(amqp_uri)
    channel = await conn.channel()
    await channel.set_qos(prefetch_count=prefetch_count)

    # It is important that all applications, that use a queue, declare it in the same way
    queue_args = {}
    if max_length is not None:
        queue_args["x-max-length"] = max_length
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms
    queue = await channel.declare_queue(queue_name, arguments=queue_args)

    async for message in generator():
        while True:
            try:
                await channel.default_exchange.publish(
                    aio_pika.Message(body=serialize(message)), routing_key=queue.name
                )
                break
            except (
                aio_pika.exceptions.DeliveryError,
                aiormq.exceptions.ChannelInvalidStateError,
                ConnectionResetError,
                ConnectionRefusedError,
                RuntimeError,
            ):
                await asyncio.sleep(0.5)

    await channel.close()
    await conn.close()


async def publisher_consumer(
    amqp_uri,
    queue_names: tuple[str, str],
    jobber,
    /,
    prefetch_count=1,
    max_length=(None, None),
    ack_timeout_ms=(None, None),
):
    import asyncio
    import aio_pika, aiormq

    conn = await robust_connect(amqp_uri)
    channel = await conn.channel()
    await channel.set_qos(prefetch_count=prefetch_count)

    # It is important that all applications, that use a queue, declare it in the same way
    queue_args = {}
    if max_length[0] is not None:
        queue_args["x-max-length"] = max_length[0]
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms[0] is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms[0]
    consumer_queue = await channel.declare_queue(queue_names[0], arguments=queue_args)
    queue_args = {}
    if max_length[1] is not None:
        queue_args["x-max-length"] = max_length[1]
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms[1] is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms[1]
    producer_queue = await channel.declare_queue(queue_names[1], arguments=queue_args)

    try:
        while True:
            try:
                message = await consumer_queue.get()
                async with message.process():
                    result = await jobber(deserialize(message.body))
                    while True:
                        try:
                            await channel.default_exchange.publish(
                                aio_pika.Message(body=serialize(result)),
                                routing_key=producer_queue.name,
                            )
                            break
                        except (
                            aio_pika.exceptions.DeliveryError,
                            aiormq.exceptions.ChannelInvalidStateError,
                            ConnectionResetError,
                            ConnectionRefusedError,
                            RuntimeError,
                        ):
                            await asyncio.sleep(0.5)
            except aio_pika.exceptions.QueueEmpty:
                await asyncio.sleep(5)
    finally:
        await channel.close()
        await conn.close()


async def publisher_consumer_with_worker(
    amqp_uri,
    queue_names: tuple[str, str],
    worker: Callable[
        [aio_pika.abc.AbstractRobustQueue, Callable[[Any], Coroutine[Any, Any, None]]],
        Coroutine[Any, Any, None],
    ],
    /,
    nworker: int,
    prefetch_count=1,
    max_length=(None, None),
    ack_timeout_ms=(None, None),
):
    """

    :param amqp_uri:
    :param queue_names:
    :param worker: signature: worker(consumer_queue: aio_pika.Queue, publish: async function(data: any))
                   must deserialize and acknowledge messages
    :param nworker:
    :param prefetch_count:
    :param max_length:
    :param ack_timeout_ms:
    :return:
    """
    import asyncio
    import aio_pika, aiormq

    conn = await robust_connect(amqp_uri)
    channel = await conn.channel()
    await channel.set_qos(prefetch_count=prefetch_count)

    # It is important that all applications, that use a queue, declare it in the same way
    queue_args = {}
    if max_length[0] is not None:
        queue_args["x-max-length"] = max_length[0]
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms[0] is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms[0]
    consumer_queue = await channel.declare_queue(queue_names[0], arguments=queue_args)
    queue_args = {}
    if max_length[1] is not None:
        queue_args["x-max-length"] = max_length[1]
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms[1] is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms[1]
    producer_queue = await channel.declare_queue(queue_names[1], arguments=queue_args)

    async def publish(data):
        while True:
            try:
                await channel.default_exchange.publish(
                    aio_pika.Message(body=serialize(data)),
                    routing_key=producer_queue.name,
                )
                break
            except (
                aio_pika.exceptions.DeliveryError,
                aiormq.exceptions.ChannelInvalidStateError,
                ConnectionResetError,
                ConnectionRefusedError,
                RuntimeError,
            ):
                await asyncio.sleep(0.5)

    try:
        await asyncio.gather(*[worker(consumer_queue, publish) for _ in range(nworker)])
    finally:
        await channel.close()
        await conn.close()


async def consumer(
    amqp_uri,
    queue_name,
    consume,
    /,
    prefetch_count=1,
    max_length=None,
    ack_timeout_ms=None,
):
    import asyncio
    import aio_pika

    conn = await robust_connect(amqp_uri)
    channel = await conn.channel()
    await channel.set_qos(prefetch_count=prefetch_count)

    # It is important that all applications, that use a queue, declare it in the same way
    queue_args = {}
    if max_length is not None:
        queue_args["x-max-length"] = max_length
        queue_args["x-overflow"] = "reject-publish"
    if ack_timeout_ms is not None:
        queue_args["x-consumer-timeout"] = ack_timeout_ms
    queue = await channel.declare_queue(queue_name, arguments=queue_args)

    try:
        while True:
            try:
                message = await queue.get()
                async with message.process():
                    await consume(deserialize(message.body))
            except aio_pika.exceptions.QueueEmpty:
                await asyncio.sleep(5)
    finally:
        await channel.close()
        await conn.close()


def run(future):
    import asyncio
    import uvloop

    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    asyncio.get_event_loop().run_until_complete(future)
