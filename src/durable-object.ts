import { DurableObject } from "cloudflare:workers";
import { INITIAL_STATE, modify, type Action, type S } from "./game";

function mapNull<T extends NonNullable<unknown>, U extends NonNullable<unknown>>(
	a: T | null, f: (t: T) => U
): U | null {
	if (a === null)
		return null;
	return f(a);
}

function makeError(error: unknown): string {
	return JSON.stringify({ error });
}

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
		color: [Number, Number, Number],
		nsfw?: boolean,
	} | null,
};

function validateInfo(d: unknown): d is Exclude<Loner['info'], null> {
	return typeof d === 'object' && d !== null &&
		'name' in d && typeof d.name === 'string' &&
		'desc' in d && typeof d.desc === 'string' &&
		('color' in d && Array.isArray(d.color) && d.color.length === 3
			&& d.color.every(val => typeof val === 'number'));
}

type NonLoner = {
	userId: Uuid,
	dateId: Uuid,
	info: Exclude<Loner['info'], null>,
};

type Date = {
	s: S,
	left: Uuid;
	right: Uuid;
	nsfw: boolean;
};

type DateId = Uuid;

function isNonLoner(arg: object): arg is NonLoner {
	return 'userId' in arg;
}

function isLoner(arg: object): arg is Loner {
	return 'lonerId' in arg;
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
	private pollers: Map<WebSocket, /* nsfw */ boolean>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.loners = new Map();
		this.nonLoners = new Map();
		this.pollers = new Map();

		this.ctx.getWebSockets().forEach((ws) => {
			const attachment: Loner | NonLoner | boolean = ws.deserializeAttachment();
			if (typeof attachment === 'boolean') {
				this.pollers.set(ws, attachment as boolean);
			}
			else if (isNonLoner(attachment)) {
				this.nonLoners.set(ws, { ...attachment });
			} else if (isLoner(attachment)) {
				this.loners.set(ws, { ...attachment });
			}
		});

		this.pollers.forEach((nsfw, ws) => {
			ws.send(JSON.stringify(this.get_loners(nsfw)));
		});

		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	get_loners(nsfw: boolean): (Loner & { info: Exclude<Loner['info'], null> })[] {
		const filter = (loner: Loner) => (
			loner.info !== null &&
			(nsfw || Boolean(loner.info.nsfw) === false)
		);

		return this.loners
			.entries()
			.map(([_, loner]: [WebSocket, Loner]) => loner)
			.filter(filter)
			.toArray();
	}

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

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// API: Return loners
		if (url.pathname.endsWith("/watch") && request.method === "GET") {
			if (request.headers.get("Upgrade") !== "websocket")
				return new Response('need upgrade header for websocket', { status: 400 });

			const nsfw = url.searchParams.get('nsfw')?.toLowerCase() === 'true';
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			this.ctx.acceptWebSocket(server);
			server.serializeAttachment(nsfw);
			this.pollers.set(server, nsfw);

			server.send(JSON.stringify(this.get_loners(nsfw)));

			return new Response(null, { status: 101, webSocket: client });
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
				//server.send("pls initialize");

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
				const nsfw = mapNull(url.searchParams.get('nsfw'), s => s.toLowerCase() === 'true');

				const first: [WebSocket, Loner] | undefined = this.loners.entries()
					.find(([_, loner]: [WebSocket, Loner]) => (
						loner.lonerId === firstId &&
						loner.info !== null &&
						(nsfw || !loner.info.nsfw)
					));
				if (first === undefined || first[1].info === null) { // unknown or uninitialized loner
					console.error("/date called with unknown or uninit loner", first);
					return new Response('unknown loner', { status: 400 });
				}

				const pair = new WebSocketPair();
				const [client, server] = Object.values(pair);

				const secondId = crypto.randomUUID();

				const dateId = crypto.randomUUID();
				const initDate: Date = {
					left: firstId,
					right: secondId,
					s: INITIAL_STATE,
					nsfw: Boolean(nsfw),
				};
				await this.date(dateId, initDate); // create new date

				this.ctx.acceptWebSocket(server);

				const firstNew: NonLoner = {
					userId: firstId, dateId, info: {
						name: "",
						desc: "",
						color: [0.5, 0.5, 0.5],
						nsfw: nsfw || undefined
					}
				};
				this.loners.delete(first[0]);

				this.pollers.forEach((nsfw, ws) => {
					ws.send(JSON.stringify(this.get_loners(nsfw)));
				});

				this.nonLoners.set(first[0], firstNew);
				first[0].serializeAttachment(firstNew);

				const second: NonLoner = { userId: secondId, dateId, info: first[1].info };
				this.nonLoners.set(server, second);
				server.serializeAttachment(second);

				// letting the person who created the room know that the date has started by sending the
				// initial state
				first[0].send(JSON.stringify(initDate.s));

				// add to list of loners
				return new Response(null, { status: 101, webSocket: client });
			}
			catch (e) {
				console.error("250", e);
			}
		}

		return new Response("unknown route", { status: 400 });
	}

	getSession(ws: WebSocket): Loner | NonLoner | boolean | undefined {
		return this.loners.get(ws) || this.nonLoners.get(ws) || this.pollers.get(ws);
	}

	/**
	 * WebSocket message handler (hibernation API)
	 * Called when a client sends a message
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message === 'object') {
			console.log("can't read bytes msgs");
			ws.send("can't read bytes msgs");
			return;
		}

		const session = this.getSession(ws);
		if (session === undefined) {
			return;
		}

		// client that is just polling for loners
		if (typeof session === 'boolean') {
			// no reason to talk to us
			console.log("we are not listening");
			ws.send("i am not listening");
			return;
		}

		if (isLoner(session)) {
			// initialize loner
			if (session.info === null) {
				const messageJson = JSON.parse(message);
				if (!validateInfo(messageJson)) {
					console.log("bad initialization");
					ws.send("bad initialization");
				} else {
					session.info = messageJson;
					ws.serializeAttachment(session);
					this.pollers.forEach((nsfw, ws) => {
						ws.send(JSON.stringify(this.get_loners(nsfw)));
					});
					ws.send("true");
				}
				return;
			}

			// initialized loner has no reason to talk to us
			console.log("dunno, wait for date");
			ws.send("dunno, wait for date");
			return;
		}

		const date = (await this.date(session.dateId))!;
		const isLeft = date.left === session.userId;
		const otherId = isLeft
			? date.right
			: date.left;

		const [otherWs, other]: [WebSocket, NonLoner] = this.nonLoners.entries().find(([_, nonLoner]) => nonLoner.userId === otherId)!;

		try {
			const action:
				| Action
				| { admin: AdminMessages }
				| { text: string }
				| { setMe: Exclude<Loner['info'], null> }
				| { meow: number }
				| { getMe: true }
				| { amILeft: true }
				| { names: true }
				= JSON.parse(message);

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
					console.log("closed second person in date");
					otherWs.close();
					this.nonLoners.delete(ws);
					console.log("closed first person in date");
					ws.close();
				}
				return;
			}
			else if (typeof action === 'object' && 'setMe' in action) {
				if (!validateInfo(action.setMe)) {
					console.log("setMm with bad info");
					ws.send(makeError("bad info"));
					return;
				}
				session.info = { ...action.setMe, nsfw: session.info.nsfw };
				ws.serializeAttachment(session);
				return;
			}
			else if (typeof action === 'object' && 'getMe' in action) {
				ws.send(JSON.stringify(session.info));
				return;
			}
			else if (typeof action === 'object' && 'amILeft' in action) {
				ws.send(JSON.stringify(isLeft));
				return;
			}
			else if (typeof action === 'object' && 'meow' in action) {
				otherWs.send(JSON.stringify({ meow: action.meow }));
				return;
			}
			else if (typeof action === 'object' && 'names' in action) {
				ws.send(JSON.stringify({ you: session.info.name, them: other.info.name }));
				return;
			}

			const error = modify(date.s, action, isLeft);
			if (error) {
				console.log("error modifying state: ", error);
				console.log("msg was:", action);
				ws.send(`error: ${error}`);
				return;
			}
			this.date(session.dateId, { ...date, s: date.s });

			// console.log("sent state change: ", JSON.stringify(date.s, null, 2));
			ws.send(JSON.stringify({
				state: date.s.state,
				q: date.s.q,
			}));
			otherWs.send(JSON.stringify({
				state: date.s.state,
				q: date.s.q,
			}));
		}
		catch (e) {
			console.log("caught error", e);
			ws.send(JSON.stringify({ error: "`${e}`" }));
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
		if (typeof session === 'undefined') {
			return;
		}

		if (typeof session === 'boolean') {
			console.log("closed person /watch'ing");
			this.pollers.delete(ws);
			// ws.close();
			return;
		}

		if (isNonLoner(session)) {
			console.log("removed from non-loners");
			this.nonLoners.delete(ws);

			// end date
			{
				const date = (await this.date(session.dateId))!;
				const isLeft = date.left === session.userId;
				const otherId = isLeft
					? date.right
					: date.left;

				const [otherWs, _] = this.nonLoners.entries()
					.find(([_, nonLoner]) => nonLoner.userId === otherId)!;
				await this.date(session.dateId, null);
				this.nonLoners.delete(otherWs);
				console.log("closed second person in date");
				otherWs.close();
				this.nonLoners.delete(ws);
			}
		}
		else {
			console.log("removed from loners");
			this.loners.delete(ws);

			this.pollers.forEach((nsfw, ws) => {
				ws.send(JSON.stringify(this.get_loners(nsfw)));
			});
		}

		if (isNonLoner(session))
			console.log("closed first person in date");
		else
			console.log("closed loner");
		// if (code === 1005) {
		// 	ws.close();
		// }
		// else {
		// 	ws.close(code, reason);
		// }
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

