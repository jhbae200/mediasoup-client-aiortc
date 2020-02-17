import uuidv4 from 'uuid/v4';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Logger } from 'mediasoup-client/lib/Logger';
import { EnhancedEventEmitter } from 'mediasoup-client/lib/EnhancedEventEmitter';
import { Channel } from './Channel';
import { MediaKind } from 'mediasoup-client/lib/RtpParameters';
import { FakeRTCDataChannel } from './FakeRTCDataChannel';
import { FakeRTCStatsReport } from './FakeRTCStatsReport';
import {
	HandlerSendDataChannelOptions
} from 'mediasoup-client/lib/handlers/HandlerInterface';

export type WorkerLogLevel = 'debug' | 'warn' | 'error' | 'none';

export type WorkerSettings =
{
	/**
	 * RTCConfiguration object.
	 */
	rtcConfiguration?: RTCConfiguration;

	/**
	 * Logging level for logs generated by the media worker subprocesses. Valid
	 * values are 'debug', 'warn', 'error' and 'none'. Default 'none'.
	 */
	logLevel?: WorkerLogLevel;
}

export type WorkerState = 'connecting' | 'open' | 'closed';

export type WorkerSendOptions =
{
	kind: MediaKind;
	sourceType: 'device' | 'file' | 'url';
	sourceValue?: string;
}

type WorkerSendResult =
{
	trackId: string;
};

const logger = new Logger('aiortc:Worker');

export class Worker extends EnhancedEventEmitter
{
	// mediasoup-worker child process.
	private _child?: ChildProcess;
	// Channel instance.
	private readonly _channel: Channel;
	// State.
	private _state: WorkerState = 'connecting';

	/**
	 * @emits open
	 * @emits failed - (error: Error)
	 * @emits error - (error: Error)
	 */
	constructor({ rtcConfiguration, logLevel = 'none' }: WorkerSettings = {})
	{
		super();

		logger.debug(
			'constructor() [rtcConfiguration:%o, logLevel:%o]',
			rtcConfiguration, logLevel);

		const spawnBin = process.env.PYTHON_PATH || 'python3';
		const spawnArgs: string[] = [];

		spawnArgs.push('-u'); // Unbuffered stdio.

		spawnArgs.push(path.join(__dirname, '..', 'worker', 'worker.py'));

		if (logLevel)
			spawnArgs.push(`--logLevel=${logLevel}`);

		if (rtcConfiguration && Array.isArray(rtcConfiguration.iceServers))
			spawnArgs.push(`--rtcConfiguration=${JSON.stringify(rtcConfiguration)}`);

		logger.debug(
			'spawning worker process: %s %s', spawnBin, spawnArgs.join(' '));

		this._state = 'connecting';

		this._child = spawn(
			// command
			spawnBin,
			// args
			spawnArgs,
			// options
			{
				detached : false,
				// fd 0 (stdin)   : Just ignore it.
				// fd 1 (stdout)  : Pipe it for 3rd libraries that log their own stuff.
				// fd 2 (stderr)  : Same as stdout.
				// fd 3 (channel) : Producer Channel fd.
				// fd 4 (channel) : Consumer Channel fd.
				stdio    : [ 'ignore', 'pipe', 'pipe', 'pipe', 'pipe' ]
			});

		const pid = this._child.pid;

		this._channel = new Channel(
			{
				sendSocket : this._child.stdio[3],
				recvSocket : this._child.stdio[4]
			});

		let spawnDone = false;

		this._handleWorkerNotifications();

		// Listen for 'running' notification.
		this._channel.once(String(pid), (event: string) =>
		{
			if (!spawnDone && event === 'running')
			{
				spawnDone = true;

				logger.debug('worker process running [pid:%s]', pid);

				this._state = 'open';
				this.emit('open');
			}
		});

		this._child.on('exit', (code, signal) =>
		{
			this._child = undefined;
			this.close();

			if (!spawnDone)
			{
				spawnDone = true;

				if (code === 42)
				{
					logger.error(
						'worker process failed due to wrong settings [pid:%s]', pid);

					this.emit('failed', new TypeError('wrong settings'));
				}
				else
				{
					logger.error(
						'worker process failed unexpectedly [pid:%s, code:%s, signal:%s]',
						pid, code, signal);

					this.emit(
						'failed',
						new Error(`[pid:${pid}, code:${code}, signal:${signal}]`));
				}
			}
			else
			{
				logger.error(
					'worker process died unexpectedly [pid:%s, code:%s, signal:%s]',
					pid, code, signal);

				this.emit(
					'error',
					new Error(`[pid:${pid}, code:${code}, signal:${signal}]`));
			}
		});

		this._child.on('error', (error) =>
		{
			this._child = undefined;
			this.close();

			if (!spawnDone)
			{
				spawnDone = true;

				logger.error(
					'worker process failed [pid:%s]: %s', pid, error.message);

				this.emit('failed', error);
			}
			else
			{
				logger.error(
					'worker process error [pid:%s]: %s', pid, error.message);

				this.emit('error', error);
			}
		});

		// Be ready for 3rd party worker libraries logging to stdout.
		this._child.stdout.on('data', (buffer) =>
		{
			for (const line of buffer.toString('utf8').split('\n'))
			{
				if (line)
					logger.debug(`(stdout) ${line}`);
			}
		});

		// In case of a worker bug, mediasoup will log to stderr.
		this._child.stderr.on('data', (buffer) =>
		{
			for (const line of buffer.toString('utf8').split('\n'))
			{
				if (line)
					logger.error(`(stderr) ${line}`);
			}
		});
	}

	/**
	 * Close the Worker.
	 */
	close(): void
	{
		logger.debug('close()');

		if (this._state === 'closed')
			return;

		this._state = 'closed';

		// Kill the worker process.
		if (this._child)
		{
			// Remove event listeners but leave a fake 'error' hander to avoid
			// propagation.
			this._child.stdout.removeAllListeners();
			this._child.stderr.removeAllListeners();
			this._child.removeAllListeners('exit');
			this._child.removeAllListeners('error');
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			this._child.on('error', () => {});
			this._child.kill('SIGTERM');
			this._child = undefined;
		}

		// Close the Channel instance.
		this._channel.close();
	}

	getState(): WorkerState
	{
		return this._state;
	}

	async getRtpCapabilities(): Promise<string>
	{
		logger.debug('getRtpCapabilities()');

		return this._channel.request('getRtpCapabilities');
	}

	async getLocalDescription(): Promise<RTCSessionDescription>
	{
		logger.debug('getLocalDescription()');

		return this._channel.request('getLocalDescription');
	}

	async setLocalDescription(desc: RTCSessionDescription): Promise<void>
	{
		logger.debug('setLocalDescription()');

		return this._channel.request('setLocalDescription', undefined, desc);
	}

	async setRemoteDescription(desc: RTCSessionDescription): Promise<void>
	{
		logger.debug('setRemoteDescription()');

		return this._channel.request('setRemoteDescription', undefined, desc);
	}

	async createOffer(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		{ iceRestart }:	RTCOfferOptions = {}
	): Promise<RTCSessionDescription>
	{
		logger.debug('setRemoteDescription()');

		return this._channel.request('createOffer');
	}

	async createAnswer(): Promise<RTCSessionDescription>
	{
		logger.debug('createAnswer()');

		return this._channel.request('createAnswer');
	}

	async addTrack(options: WorkerSendOptions): Promise<WorkerSendResult>
	{
		logger.debug('send() [options:%o]', options);

		return this._channel.request('addTrack', undefined, options);
	}

	async removeTrack(trackId: string): Promise<void>
	{
		logger.debug(`removeTrack() | [trackId:${trackId}]`);

		return this._channel.request('removeTrack', undefined, { trackId });
	}

	async getMid(trackId: string): Promise<string | undefined>
	{
		logger.debug('getMid()');

		try
		{
			const mid =
				await this._channel.request('getMid', undefined, { trackId });

			return mid;
		}
		catch (error)
		{
			return undefined;
		}
	}

	enableTrack(trackId: string): void
	{
		logger.debug(`enableTrack() | [trackId:${trackId}]`);

		this._channel.notify('enableTrack', undefined, { trackId });
	}

	disableTrack(trackId: string): void
	{
		logger.debug(`disableTrack() | [trackId:${trackId}]`);

		this._channel.notify('disableTrack', undefined, { trackId });
	}

	async createDataChannel(
		options: HandlerSendDataChannelOptions
	): Promise<FakeRTCDataChannel>
	{
		logger.debug('createDataChannel() [options:%o]', options);

		const internal = { dataChannelId: uuidv4() };

		await this._channel.request('createDataChannel',
			internal,
			{
				id                : options.streamId,
				ordered           : options.ordered,
				maxPacketLifeTime : options.maxPacketLifeTime || null,
				maxRetransmits    : options.maxRetransmits || null,
				label             : options.label,
				protocol          : options.protocol
			});

		return new FakeRTCDataChannel(
			internal,
			this._channel,
			{
				id                : options.streamId,
				ordered           : options.ordered,
				maxPacketLifeTime : options.maxPacketLifeTime,
				maxRetransmits    : options.maxRetransmits,
				label             : options.label,
				protocol          : options.protocol
			}
		);
	}

	async getTransportStats(): Promise<FakeRTCStatsReport>
	{
		const data = await this._channel.request('getTransportStats');

		return new FakeRTCStatsReport(data);
	}

	async getSenderStats(trackId: string): Promise<FakeRTCStatsReport>
	{
		const data =
			await this._channel.request('getSenderStats', undefined, { trackId });

		return new FakeRTCStatsReport(data);
	}

	async getReceiverStats(trackId: string): Promise<FakeRTCStatsReport>
	{
		const data =
			await this._channel.request('getReceiverStats', undefined, { trackId });

		return new FakeRTCStatsReport(data);
	}

	private _handleWorkerNotifications(): void
	{
		this._channel.on(String(this._child.pid), (event, data?: any) =>
		{
			switch (event)
			{
				case 'iceconnectionstatechange':
				{
					this.emit('iceconnectionstatechange', data as string);
					break;
				}
			}
		});
	}
}
