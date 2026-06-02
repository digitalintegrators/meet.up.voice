import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

// Create Redis client optimized for serverless environments (Vercel)
export const redis = redisUrl
	? new Redis(redisUrl, {
			family: 0,
			maxRetriesPerRequest: null, 
			connectTimeout: 10000,
			commandTimeout: 5000,
			keepAlive: 0,
			enableOfflineQueue: true,
			retryStrategy(times) {
				const delay = Math.min(times * 100, 3000);
				return delay;
			},
			// Upstash / Vercel rediss:// connections require TLS
			tls: (redisUrl.startsWith("rediss:") || redisUrl.includes("upstash") || process.env.NODE_ENV === "production") ? { rejectUnauthorized: false } : undefined,
	  })
	: new Redis({
			family: 0,
			lazyConnect: true,
			maxRetriesPerRequest: null,
			connectTimeout: 5000,
	  });

// Silence connection/write errors so they do not crash Server Actions or SSR builds
redis.on("error", (err) => {
	console.warn("ioredis background error:", err.message);
});




