const autoLoad = require("fastify-autoload");
const fp = require("fastify-plugin");
const path = require("path");

// Import plugins
const accepts = require("fastify-accepts");
const auth = require("fastify-auth");
const helmet = require("fastify-helmet");
const disableCache = require("fastify-disablecache");
const flocOff = require("fastify-floc-off");
const rateLimit = require("fastify-rate-limit");
const underPressure = require("under-pressure");
const jwtJwks = require("./plugins/jwt-jwks-auth");

/**
 * @author Frazer Smith
 * @description Build Fastify instance
 * @param {Function} server - Fastify instance.
 * @param {object} config - Fastify configuration values
 */
async function plugin(server, config) {
	// Enable plugins
	server
		.register(accepts)

		.register(auth)

		.register(disableCache)

		.register(flocOff)

		// Process load and 503 response handling
		.register(underPressure, config.processLoad)

		// Rate limiting and 429 response handling
		.register(rateLimit, config.rateLimit)

		.register(jwtJwks, config.jwt)

		// Use Helmet to set response security headers: https://helmetjs.github.io/
		.register(helmet, {
			contentSecurityPolicy: {
				directives: {
					...helmet.contentSecurityPolicy.getDefaultDirectives(),
					"form-action": ["'self'"],
				},
			},
			referrerPolicy: {
				/**
				 * "no-referrer" will only be used as a fallback if "strict-origin-when-cross-origin"
				 * is not supported by the browser
				 */
				policy: ["no-referrer", "strict-origin-when-cross-origin"],
			},
		})

		.register(autoLoad, {
			dir: path.join(__dirname, "routes"),
			options: config,
		});
}

module.exports = fp(plugin);
