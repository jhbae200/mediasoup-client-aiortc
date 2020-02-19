import argparse
import traceback
import asyncio
import json
import signal
import sys
from os import getpid
from aiortc import (
    RTCConfiguration,
    RTCIceServer
)
from aiortc.contrib.media import MediaPlayer
from channel import Request, Notification, Channel
from handler import Handler
from logger import rootLogger, debugLogger, errorLogger


# File descriptors to communicate with the Node.js process
READ_FD = 3
WRITE_FD = 4


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="aiortc mediasoup-client handler")
    parser.add_argument("--logLevel", "-l",
                        choices=["debug", "warn", "error", "none"])
    parser.add_argument("--rtcConfiguration", "-c",
                        help="RTCConfiguration string")
    args = parser.parse_args()

    """
    Argument handling
    """
    if args.logLevel and args.logLevel != "none":
        rootLogger.setLevel(args.logLevel.upper())
        debugLogger.setLevel(args.logLevel.upper())
        errorLogger.setLevel(args.logLevel.upper())

    debugLogger.debug("starting mediasoup-client aiortc worker")

    # use RTCConfiguration if given
    rtcConfiguration = None

    if args.rtcConfiguration:
        jsonRtcConfiguration = json.loads(args.rtcConfiguration)
        if "iceServers" in jsonRtcConfiguration:
            iceServers = []
            for entry in jsonRtcConfiguration["iceServers"]:
                iceServer = RTCIceServer(
                    urls=entry["urls"] if "urls" in entry else None,
                    username=entry["username"] if "username" in entry else None,
                    credential=entry["credential"] if "credential" in entry else None,
                    credentialType=entry["credentialType"] if "credentialType" in entry else None)
                iceServers.append(iceServer)
            rtcConfiguration = RTCConfiguration(iceServers)

    """
    Initialization
    """
    # run event loop
    loop = asyncio.get_event_loop()

    # create channel
    channel = Channel(loop, READ_FD, WRITE_FD)

    # create handler
    try:
        handler = Handler(channel, rtcConfiguration)
    except Exception as error:
        errorLogger.error(f"invalid RTCConfiguration: {error}")
        sys.exit(42)

    def shutdown():
        loop.stop()
        # TODO: If loop.close() is not called, the channel will continue reading
        # after the Node side is closed, producing an infinite loop.
        # However, this produces a log "Cannot close a running event loop".
        loop.close()

    async def run(channel: Channel, handler: Handler) -> None:
        # tell the Node process that we are running
        await channel.notify(getpid(), "running")

        while True:
            try:
                obj = await channel.receive()

                if obj is None:
                    continue

                elif "method" in obj:
                    request = Request(**obj)
                    request.setChannel(channel)
                    try:
                        result = await handler.processRequest(request)
                        await request.succeed(result)
                    except Exception as error:
                        errorLogger.error(f"request '{request.method}' failed: '{error}'")
                        if not isinstance(error, TypeError):
                            traceback.print_tb(error.__traceback__)
                        await request.failed(error)

                elif "event" in obj:
                    notification = Notification(**obj)
                    try:
                        await handler.processNotification(notification)
                    except Exception as error:
                        errorLogger.error(f"notification '{notification.event}' failed: {error}")
                        if not isinstance(error, TypeError):
                            traceback.print_tb(error.__traceback__)

            except Exception:
                break

    # signal handler
    loop.add_signal_handler(signal.SIGINT, shutdown)
    loop.add_signal_handler(signal.SIGTERM, shutdown)

    try:
        loop.run_until_complete(
            run(channel, handler)
        )
    # reached after calling loop.stop()
    except RuntimeError:
        pass
    finally:
        loop.run_until_complete(handler.close())
        loop.run_until_complete(channel.close())
