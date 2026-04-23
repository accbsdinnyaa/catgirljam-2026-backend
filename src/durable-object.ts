import { DurableObject } from "cloudflare:workers";
import { INITIAL_STATE, modify, type Action, type S } from "./game";

export const INSTANCE_NAME = "catgirl";

type Uuid = ReturnType<(typeof crypto)['randomUUID']>;

type AdminMessages =
	| 'close'
	| 'state';

type Loner = {
	lonerId: Uuid,
	// null if not initialized
	info: {
		name: string,
		desc: string,
	} | null,
};

function validateInfo(d: unknown): d is Exclude<Loner['info'], null> {
	return typeof d === 'object' && d !== null &&
		'name' in d && typeof d.name === 'string' &&
		'desc' in d && typeof d.desc === 'string';
}

type NonLoner = {
	userId: Uuid,
	dateId: Uuid,
};

// const lonerFromRaw = (raw: Record<string, any>): Loner => ({ ...raw, sender: null } as Loner);

type Date = {
	s: S,
	left: Uuid;
	right: Uuid;
};

// const dateFromRaw = (raw: Record<string, any>): Date => (raw as Date);

// const lonersFromRaw = (raw: Array<any>): Loners => new Set(raw.map(lonerFromRaw));

// type Dates = Array<Date>;
// const datesFromRaw = (raw: Array<any>): Dates => raw.map(dateFromRaw);

// type Pairs = Map<string, Map<string, /* index in `dates` */ number>>;
/* const pairsFromRaw = (raw: Record<string, any>): Pairs => {
	return new Map(
		Object.entries(raw)
			.map(([key, value]) =>
				[key, new Map(Object.entries(value))])
	);
} */

/* type Event = {
	lonerId: number;
	runAt: number;
	repeatMs: number | null;
}; */

type DateId = Uuid;

function isNonLoner(arg: any): arg is NonLoner {
	return 'userId' in arg;
}

/**
 * WorkflowStatusDO - Durable Object for managing workflow state and WebSocket connections
 *
 * Responsibilities:
 * - Accept and manage WebSocket connections using hibernation API
 * - Track step statuses for a workflow instance
 * - Broadcast updates to all connected clients
 * - Provide RPC method for workflow to update step status
 */
export class MyDurableObject extends DurableObject {

	// sessions: Map<WebSocket, { [key: string]: string }>;
	private loners: Map<WebSocket, Loner>;
	private nonLoners: Map<WebSocket, NonLoner>;

	// get
	async date(id: DateId): Promise<Date | undefined>;
	// put
	async date(id: DateId, newDate: Date): Promise<void>;
	// delete
	async date(id: DateId, newDate: null): Promise<void>;

	async date(id: DateId, newDate?: Date | null) {
		const dateId = `date:${id}`;

		if (newDate) {
			this.ctx.storage.put(dateId, newDate);
		}
		else if (newDate === null) {
			this.ctx.storage.delete(dateId);
		}
		else if (newDate === undefined) {
			return this.ctx.storage.get(dateId);
		}
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.loners = new Map();
		this.nonLoners = new Map();

		this.ctx.getWebSockets().forEach((ws) => {
			const attachment: Loner | NonLoner = ws.deserializeAttachment();
			if (isNonLoner(attachment)) {
				this.nonLoners.set(ws, { ...attachment });
			} else {
				this.loners.set(ws, { ...attachment });
			}
		});

		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

		ctx.blockConcurrencyWhile(async () => {

			/*
			const storedLoners = await ctx.storage.get<Array<any>>("loners");
			// const storedDates = await ctx.storage.get<Array<any>>("dates");
			const storedPairs = await ctx.storage.get<Record<string, any>>("pairs");
			const storedCounter = await ctx.storage.get<number>("counter");

			if (storedLoners) {
				// TODO handle restart of DO with loners still waiting
				this.loners = lonersFromRaw(storedLoners);
			}
			// if (storedDates) {
			// 	// TODO handle restart of DO with dates still active
			// 	this.dates = datesFromRaw(storedDates);
			// }
			if (storedPairs) {
				// TODO handle restart of worker with dates still active
				this.pairs = pairsFromRaw(storedPairs);
			}
			if (storedCounter) {
				this.counter = storedCounter;
			}
			*/

		});
	}

	/* async addLoner(loner: Loner) {
		this.loners.add(loner);
		await this.ctx.storage.put("loners", this.loners);
	} */

	// Schedule a one-time or recurring event
	/* async scheduleEvent(id: number, runAt: number, repeatMs: number | null = null) {
		await this.ctx.storage.put(`event:${id}`, { id, runAt, repeatMs });
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (!currentAlarm || runAt < currentAlarm) {
			await this.ctx.storage.setAlarm(runAt);
		}
	}


	async alarm() {
		const now = Date.now();
		const events = await this.ctx.storage.list<Event>({ prefix: "event:" });
		let nextAlarm = null;

		for (const [key, event] of events) {
			if (event.runAt <= now) {
				await this.processEvent(event);
				if (event.repeatMs) {
					event.runAt = now + event.repeatMs;
					await this.ctx.storage.put(key, event);
				} else {
					await this.ctx.storage.delete(key);
				}
			}
			// Track the next event time
			if (event.runAt > now && (!nextAlarm || event.runAt < nextAlarm)) {
				nextAlarm = event.runAt;
			}
		}

		if (nextAlarm) await this.ctx.storage.setAlarm(nextAlarm);
	}
	*/

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// API: Return loners
		if (url.pathname.endsWith("/loners") && request.method === "GET") {
			const loners = this.loners
				.entries()
				.map(([_, loner]) => loner)
				.filter(loner => loner.info !== null)
				.toArray();

			return Response.json(loners);
		}

		// API: Create a new room & wait for a date
		if (url.pathname.endsWith("/room") && request.method === "GET") {
			if (request.headers.get("Upgrade") !== "websocket")
				return new Response('need upgrade header for websocket', { status: 400 });

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const lonerId = crypto.randomUUID();
			try {
				this.ctx.acceptWebSocket(server);

				const attachment: Loner = { lonerId, info: null }; // set uninitialized loner
				server.serializeAttachment(attachment);

				// add to list of loners
				this.loners.set(server, attachment);

				server.send("pls initialize");

				return new Response(null, { status: 101, webSocket: client });
			}
			catch (e) {
				return new Response(e as string, { status: 400 });
			}
		}

		// API: Join an existing room and start a date
		if (url.pathname.endsWith("/date") && request.method === "GET") {
			if (request.headers.get("Upgrade") !== "websocket")
				return new Response('need upgrade header for websocket', { status: 400 });

			try {
				const firstId = url.searchParams.get('lonerId');
				if (firstId === null)
					return new Response('?lonerId= needed', { status: 400 });

				const first = this.loners.entries().find(([_, loner]) => loner.lonerId === firstId);
				if (first === undefined || first[1].info === null) { // unknown or uninitialized loner
					console.error("/date called with unknown or uninit loner", first);
					return new Response('unknown loner', { status: 400 });
				}

				const pair = new WebSocketPair();
				const [client, server] = Object.values(pair);

				const secondId = crypto.randomUUID();

				const dateId = crypto.randomUUID();
				await this.date(dateId, { left: firstId, right: secondId, s: INITIAL_STATE });

				this.ctx.acceptWebSocket(server);

				const firstNew: NonLoner = { userId: firstId, dateId };
				this.loners.delete(first[0]);
				this.nonLoners.set(first[0], firstNew);
				first[0].serializeAttachment(firstNew);

				const second: NonLoner = { userId: secondId, dateId };
				this.nonLoners.set(server, second);
				server.serializeAttachment(second);

				first[0].send("you got date");

				// add to list of loners
				return new Response(null, { status: 101, webSocket: client });
			}
			catch (e) {
				console.error("250", e);
			}
		}

		return new Response("unknown route", { status: 400 });
	}

	getSession(ws: WebSocket): Loner | NonLoner {
		return this.loners.get(ws) || this.nonLoners.get(ws)!;
	}

	/**
	 * WebSocket message handler (hibernation API)
	 * Called when a client sends a message
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message === 'object') {
			ws.send("can't read bytes msgs");
			return;
		}
		const session = this.getSession(ws);

		if (!isNonLoner(session)) {
			// initialize loner
			if (session.info === null) {
				const messageJson = JSON.parse(message);
				if (!validateInfo(messageJson)) {
					ws.send("bad initialization");
				} else {
					session.info = messageJson;
					ws.serializeAttachment(session);
					ws.send("thanks for initializing");
				}
				return;
			}

			// initialized loner has no reason to talk to us
			ws.send("dunno, wait for date");
			return;
		}

		const date = (await this.date(session.dateId))!;
		const isLeft = date.left === session.userId;
		const otherId = isLeft
			? date.right
			: date.left;

		const [otherWs, _] = this.nonLoners.entries().find(([_, nonLoner]) => nonLoner.userId === otherId)!;

		try {
			const action: Action | { admin: AdminMessages } | { text: string } = JSON.parse(message);

			if (typeof action === 'object' && 'text' in action) {
				otherWs.send(JSON.stringify({ text: action.text }));
				return;
			}
			else if (typeof action === 'object' && 'admin' in action) {
				if (action.admin === 'state') {
					ws.send(JSON.stringify(date.s));
				}
				else if (action.admin === 'close') {
					// end date
					await this.date(session.dateId, null);
					this.nonLoners.delete(otherWs);
					otherWs.close();
					this.nonLoners.delete(ws);
					ws.close();
				}
				return;
			}

			const error = modify(date.s, action, isLeft);
			if (error) {
				ws.send(`error: ${error}`);
				return
			}
			this.date(session.dateId, { ...date, s: date.s });

			ws.send(JSON.stringify(date.s));
			otherWs.send(JSON.stringify(date.s));
		}
		catch (e) {
			ws.send(JSON.stringify({ error: `${e}` }));
		}
	}

	/**
	 * WebSocket close handler (hibernation API)
	 * Called when a client closes the connection
	 */
	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const session = this.getSession(ws);

		if (code === 1005)
			ws.close();
		else
			ws.close(code, reason);

		if (isNonLoner(session)) {
			// TODO also end date
			console.log("removed from non-loners");
			this.nonLoners.delete(ws);
		} else {
			console.log("removed from loners");
			this.loners.delete(ws);
		}
	}

	/**
	 * Broadcast a message to all connected WebSocket clients
	 */
	/* private broadcast(message: object): void {
		const sockets = this.ctx.getWebSockets();
		const json = JSON.stringify(message);

		for (const socket of sockets) {
			try {
				socket.send(json);
			} catch {
				// Ignore errors for disconnected sockets
			}
		}
	} */

	/**
	 * Get the current state as a message object
	 */
	/* private getStateMessage(): object {
		return {
			type: "workflow_update",
			currentStep: this.currentStep,
			stepStatuses: Object.fromEntries(this.stepStatuses),
			workflowStatus: this.workflowStatus,
			timestamp: Date.now(),
		};
	} */
}

