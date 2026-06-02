import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

// Create Redis client optimized for serverless environments (Vercel)
export const redis = redisUrl
	? new Redis(redisUrl, {
			// Instead of 0 (which triggers error immediately on temporary drop),
			// we allow a fallback retry strategy that prevents crashing.
			maxRetriesPerRequest: null, 
			connectTimeout: 10000,
			// Disabling keepAlive prevents socket closure EPIPE issues on lambda freezing
			keepAlive: 0,
			// Allow queueing commands while reconnecting
			enableOfflineQueue: true,
			// Reconnect attempt backoff strategy
			retryStrategy(times) {
				const delay = Math.min(times * 100, 3000);
				return delay;
			},
			// Enable TLS/SSL explicitly if using rediss://
			tls: redisUrl.startsWith("rediss:") ? { rejectUnauthorized: false } : undefined,
	  })
	: new Redis({
			lazyConnect: true,
			maxRetriesPerRequest: null,
			connectTimeout: 5000,
	  });

// Silence connection/write errors so they do not crash Server Actions or SSR builds
redis.on("error", (err) => {
	console.warn("ioredis background error:", err.message);
});



