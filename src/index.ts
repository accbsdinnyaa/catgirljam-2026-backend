import { INSTANCE_NAME } from "./durable-object";

export { MyDurableObject } from "./durable-object";

/**
 * Main Worker fetch handler
 *
 * Handles API routes and WebSocket upgrade requests for workflow management:
 * - GET /ws - WebSocket connection for real-time updates
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// WebSocket: Connect to workflow status updates
		if (url.pathname.startsWith("/ws")) {
			// const instanceId = url.searchParams.get("instanceId");
			// if (!instanceId) {
			// 	return new Response("instanceId query parameter required", {
			// 		status: 400,
			// 	});
			// }

			try {
				const stub = env.MY_DURABLE_OBJECT.getByName(INSTANCE_NAME);
				return stub.fetch(request);
			} catch {
				return new Response("Failed to establish WebSocket connection", {
					status: 500,
				});
			}
		}

		return Response.json({ error: "Not Found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
