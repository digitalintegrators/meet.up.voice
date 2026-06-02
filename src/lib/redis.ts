import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

// Create Redis client optimized for serverless environments (Vercel)
export const redis = redisUrl
	? new Redis(redisUrl, {
			maxRetriesPerRequest: null, 
			connectTimeout: 10000,
			commandTimeout: 5000,
			keepAlive: 0,
			enableOfflineQueue: true,
			retryStrategy(times) {
				const delay = Math.min(times * 100, 3000);
				return delay;
			},
			// Upstash rediss:// connections require passing an empty tls object {} 
			// to enable TLS/SSL negotiations properly.
			tls: redisUrl.startsWith("rediss:") ? {} : undefined,
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




