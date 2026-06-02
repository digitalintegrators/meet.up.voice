import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

// Create Redis client optimized for serverless environments (Vercel)
export const redis = redisUrl
	? new Redis(redisUrl, {
			maxRetriesPerRequest: 0,
			connectTimeout: 5000,
			disconnectTimeout: 2000,
			// Enable TLS/SSL explicitly if using rediss://
			tls: redisUrl.startsWith("rediss:") ? { rejectUnauthorized: false } : undefined,
	  })
	: new Redis({
			lazyConnect: true,
			maxRetriesPerRequest: 0,
			connectTimeout: 5000,
	  });

// Silence connection/write errors so they do not crash Server Actions or SSR builds
redis.on("error", (err) => {
	console.warn("ioredis background error:", err.message);
});


