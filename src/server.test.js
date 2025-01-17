const { chromium, firefox } = require("playwright");
const Fastify = require("fastify");
const isHtml = require("is-html");
const createJWKSMock = require("mock-jwks").default;
const nock = require("nock");
const { readPatient, searchPatient } = require("../test_resources/constants");
const startServer = require("./server");
const getConfig = require("./config");

// Expected response headers
const expResHeaders = {
	"cache-control": "no-store, max-age=0, must-revalidate",
	connection: "keep-alive",
	"content-length": expect.stringMatching(/\d+/),
	"content-security-policy": "default-src 'self';frame-ancestors 'none'",
	"content-type": "application/fhir+json; charset=UTF-8",
	date: expect.any(String),
	expires: "0",
	"permissions-policy": "interest-cohort=()",
	pragma: "no-cache",
	"referrer-policy": "no-referrer",
	"strict-transport-security": "max-age=31536000; includeSubDomains",
	"surrogate-control": "no-store",
	vary: "Origin, accept-encoding",
	"x-content-type-options": "nosniff",
	"x-dns-prefetch-control": "off",
	"x-download-options": "noopen",
	"x-frame-options": "SAMEORIGIN",
	"x-permitted-cross-domain-policies": "none",
	"x-ratelimit-limit": expect.any(Number),
	"x-ratelimit-remaining": expect.any(Number),
	"x-ratelimit-reset": expect.any(Number),
};

const expResHeadersHtml = {
	...expResHeaders,
	"content-security-policy":
		"default-src 'self';base-uri 'self';img-src 'self' data:;object-src 'none';child-src 'self';frame-ancestors 'none';form-action 'self';upgrade-insecure-requests;block-all-mixed-content",
	"content-type": expect.stringMatching(/^text\/html; charset=utf-8$/i),
	"x-xss-protection": "0",
};

const expResHeadersHtmlStatic = {
	...expResHeadersHtml,
	"accept-ranges": "bytes",
	"cache-control": "public, max-age=300",
	"content-length": expect.any(Number), // @fastify/static plugin returns content-length as number
	"content-security-policy":
		"default-src 'self';base-uri 'self';img-src 'self' data:;object-src 'none';child-src 'self';frame-ancestors 'none';form-action 'self';upgrade-insecure-requests;block-all-mixed-content;script-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline'",
	etag: expect.any(String),
	expires: undefined,
	"last-modified": expect.any(String),
	pragma: undefined,
	"surrogate-control": undefined,
	vary: "accept-encoding",
};

const expeResHeadersPublicImage = {
	...expResHeaders,
	"accept-ranges": "bytes",
	"cache-control": "public, max-age=31536000, immutable",
	"content-length": expect.any(Number), // @fastify/static plugin returns content-length as number
	"content-type": expect.stringMatching(/^image\//i),
	etag: expect.any(String),
	expires: undefined,
	"last-modified": expect.any(String),
	pragma: undefined,
	"surrogate-control": undefined,
	vary: "accept-encoding",
};

const expResHeadersJson = {
	...expResHeaders,
	"content-type": expect.stringMatching(
		/^application\/json; charset=utf-8$/i
	),
};

const expResHeadersText = {
	...expResHeaders,
	"content-type": expect.stringMatching(/^text\/plain; charset=utf-8$/i),
};

const expResHeaders4xxErrors = {
	...expResHeadersJson,
	vary: undefined,
};

const expResHeaders4xxErrorsXml = {
	...expResHeaders4xxErrors,
	"content-security-policy":
		"default-src 'self';base-uri 'self';img-src 'self' data:;object-src 'none';child-src 'self';frame-ancestors 'none';form-action 'self';upgrade-insecure-requests;block-all-mixed-content",
	"content-type": expect.stringMatching(/^application\/xml; charset=utf-8$/i),
	"x-xss-protection": "0",
};

describe("Server deployment", () => {
	const invalidIssuerUri = "https://invalid-issuer.somersetft.nhs.uk";
	const validIssuerUri = "https://valid-issuer.somersetft.nhs.uk";
	let mockJwksServerOne;
	let mockJwksServerTwo;
	let token;

	beforeAll(() => {
		Object.assign(process.env, {
			FORWARD_URL: "http://unsecured-server.somersetft.nhs.uk",
		});

		nock.disableNetConnect();

		// Create an issuer that we have a valid JWT for
		nock(validIssuerUri)
			.get("/.well-known/openid-configuration")
			.reply(200, {
				jwks_uri: "https://valid-issuer.somersetft.nhs.uk/jwks",
			})
			.persist();
		mockJwksServerOne = createJWKSMock(
			"https://valid-issuer.somersetft.nhs.uk",
			"/jwks"
		);
		mockJwksServerOne.start();

		token = mockJwksServerOne.token({
			aud: "private",
			iss: validIssuerUri,
		});

		// Create an issuer that we do not have a valid JWT for
		nock(invalidIssuerUri)
			.get("/.well-known/openid-configuration")
			.reply(200, {
				jwks_uri: "https://invalid-issuer.somersetft.nhs.uk/jwks",
			})
			.persist();
		mockJwksServerTwo = createJWKSMock(
			"https://invalid-issuer.somersetft.nhs.uk",
			"/jwks"
		);
		mockJwksServerTwo.start();

		// Create FHIR endpoints
		nock("http://unsecured-server.somersetft.nhs.uk")
			.defaultReplyHeaders({
				"Access-Control-Allow-Methods":
					"GET, POST, PUT, DELETE, OPTIONS",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Expose-Headers": "Content-Location, Location",
				"Content-Type": "application/fhir+json; charset=UTF-8",
				ETag: 'W/"1"',
				"Last-Modified": "Tue, 10 Oct 2021 08:55:07 GMT",
				Server: "Mirth Connect FHIR Server (3.12.0.ydh001)",
			})
			.replyContentLength()
			.replyDate()
			.persist()
			// Read patient
			.get("/STU3/Patient/5484125")
			.reply(200, readPatient)
			// Search patient
			.persist()
			.get("/STU3/Patient")
			.query({
				identifier: "5484126",
				birthdate: ["ge2021-01-01", "le2021-05-01"],
			})
			.reply(200, searchPatient);
	});

	afterAll(async () => {
		nock.cleanAll();
		nock.enableNetConnect();
		await Promise.all([mockJwksServerOne.stop(), mockJwksServerTwo.stop()]);
	});

	describe("CORS", () => {
		let config;
		let server;
		let currentEnv;

		beforeAll(() => {
			Object.assign(process.env, {
				AUTH_BEARER_TOKEN_ARRAY: "",
				CORS_ALLOWED_HEADERS:
					"Accept, Accept-Encoding, Accept-Language, Authorization, Content-Type, Origin, X-Forwarded-For, X-Requested-With",
				CORS_MAX_AGE: 7200,
				JWT_JWKS_ARRAY: "",
			});
			currentEnv = { ...process.env };
		});

		const corsTests = [
			{
				testName: "CORS disabled",
				envVariables: {
					CORS_ORIGIN: "",
				},
				request: {
					headers: {
						origin: null,
					},
				},
				expected: {
					response: {
						headers: {
							basic: expResHeaders,
							json: expResHeadersJson,
							text: expResHeadersText,
						},
					},
				},
			},
			{
				testName: "CORS enabled",
				envVariables: {
					CORS_ORIGIN: true,
				},
				request: {
					headers: {
						origin: "https://notreal.somersetft.nhs.uk",
					},
				},
				expected: {
					response: {
						headers: {
							basic: {
								...expResHeaders,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
							json: {
								...expResHeadersJson,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
							text: {
								...expResHeadersText,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
						},
					},
				},
			},
			{
				testName: "CORS enabled and set to string",
				envVariables: {
					CORS_ORIGIN: "https://notreal.somersetft.nhs.uk",
				},
				request: {
					headers: {
						origin: "https://notreal.somersetft.nhs.uk",
					},
				},
				expected: {
					response: {
						headers: {
							basic: {
								...expResHeaders,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
							json: {
								...expResHeadersJson,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
							text: {
								...expResHeadersText,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
						},
					},
				},
			},
			{
				testName: "CORS enabled and set to array of strings",
				envVariables: {
					CORS_ORIGIN: [
						"https://notreal.somersetft.nhs.uk",
						"https://notreal.sft.nhs.uk",
					],
				},
				request: {
					headers: {
						origin: "https://notreal.somersetft.nhs.uk",
					},
				},
				expected: {
					response: {
						headers: {
							basic: {
								...expResHeaders,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
							json: {
								...expResHeadersJson,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
							text: {
								...expResHeadersText,
								"access-control-allow-origin":
									"https://notreal.somersetft.nhs.uk",
							},
						},
					},
				},
			},
			{
				testName: "CORS enabled and set to wildcard",
				envVariables: {
					CORS_ORIGIN: "*",
				},
				request: {
					headers: {
						origin: "https://notreal.somersetft.nhs.uk",
					},
				},
				expected: {
					response: {
						headers: {
							basic: {
								...expResHeaders,
								"access-control-allow-origin": "*",
							},
							json: {
								...expResHeadersJson,
								"access-control-allow-origin": "*",
							},
							text: {
								...expResHeadersText,
								"access-control-allow-origin": "*",
							},
						},
					},
				},
			},
		];
		describe.each(corsTests)(
			"$testName",
			({ envVariables, expected, request }) => {
				beforeAll(async () => {
					Object.assign(process.env, envVariables);
					config = await getConfig();
					// Use Node's core HTTP client as Undici HTTP client throws when used with mocks
					config.forward.undici = undefined;
					config.forward.http = true;

					server = Fastify();
					await server.register(startServer, config).ready();
				});

				afterAll(async () => {
					// Reset the process.env to default after all tests in describe block
					Object.assign(process.env, currentEnv);

					await server.close();
				});

				describe("/admin/healthcheck route", () => {
					it("Returns `ok`", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/admin/healthcheck",
							headers: {
								accept: "text/plain",
								origin: request.headers.origin,
							},
						});

						expect(response.payload).toBe("ok");
						expect(response.headers).toEqual(
							expected.response.headers.text
						);
						expect(response.statusCode).toBe(200);
					});

					// Only applicable if CORS enabled
					if (envVariables.CORS_ORIGIN) {
						it("Returns response to CORS preflight request", async () => {
							const response = await server.inject({
								method: "OPTIONS",
								url: "/admin/healthcheck",
								headers: {
									"access-control-request-method": "GET",
									origin: request.headers.origin,
								},
							});

							expect(response.payload).toBe("");
							expect(response.headers).toEqual({
								...expResHeaders,
								"access-control-allow-headers":
									process.env.CORS_ALLOWED_HEADERS,
								"access-control-allow-methods": "GET, HEAD",
								"access-control-allow-origin":
									envVariables.CORS_ORIGIN === "*"
										? "*"
										: request.headers.origin,
								"access-control-max-age": String(
									process.env.CORS_MAX_AGE
								),
								"content-type": undefined,
								vary: "Origin",
							});
							expect(response.statusCode).toBe(204);
						});
					}

					it("Returns HTTP status code 406 if media type in `Accept` request header is unsupported", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/admin/healthcheck",
							headers: {
								accept: "application/javascript",
								origin: request.headers.origin,
							},
						});

						expect(JSON.parse(response.payload)).toEqual({
							error: "Not Acceptable",
							message: "Not Acceptable",
							statusCode: 406,
						});
						expect(response.headers).toEqual(
							expected.response.headers.json
						);
						expect(response.statusCode).toBe(406);
					});
				});

				describe("/forward route", () => {
					it("Forwards request to 'FORWARD_URL'", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/STU3/Patient/5484125",
							headers: {
								accept: "application/fhir+json",
								origin: request.headers.origin,
							},
						});

						expect(JSON.parse(response.payload)).toHaveProperty(
							"resourceType",
							"Patient"
						);
						expect(response.headers).toEqual(
							expected.response.headers.basic
						);
						expect(response.statusCode).toBe(200);
					});

					it("Forwards request to 'FORWARD_URL' using search route and query string params", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/STU3/Patient",
							headers: {
								accept: "application/fhir+json",
								origin: request.headers.origin,
							},
							query: {
								identifier: "5484126",
								birthdate: ["ge2021-01-01", "le2021-05-01"],
							},
						});

						expect(JSON.parse(response.payload)).toHaveProperty(
							"resourceType",
							"Bundle"
						);
						expect(response.headers).toEqual(
							expected.response.headers.basic
						);
						expect(response.statusCode).toBe(200);
					});

					// Only applicable to "CORS Enabled" test
					if (envVariables.CORS_ORIGIN === true) {
						it("Does not set 'access-control-allow-origin' if configured to reflect 'origin' in request header, but 'origin' missing", async () => {
							const response = await server.inject({
								method: "GET",
								url: "/STU3/Patient/5484125",
								headers: {
									accept: "application/fhir+json",
								},
							});

							expect(JSON.parse(response.payload)).toHaveProperty(
								"resourceType",
								"Patient"
							);
							expect(response.headers).toEqual(expResHeaders);
							expect(response.statusCode).toBe(200);
						});
					}

					it("Returns HTTP status code 406 if content-type in `Accept` request header unsupported", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/STU3/Patient/5484125",
							headers: {
								accept: "application/javascript",
								origin: request.headers.origin,
							},
						});

						expect(JSON.parse(response.payload)).toEqual({
							error: "Not Acceptable",
							message: "Not Acceptable",
							statusCode: 406,
						});
						expect(response.headers).toEqual(
							expected.response.headers.json
						);
						expect(response.statusCode).toBe(406);
					});
				});

				describe("Undeclared route", () => {
					it("Returns HTTP status code 404 if route not found", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/invalid",
							headers: {
								accept: "application/fhir+json",
								origin: request.headers.origin,
							},
						});

						expect(JSON.parse(response.payload)).toEqual({
							error: "Not Found",
							message: "Route GET:/invalid not found",
							statusCode: 404,
						});
						expect(response.headers).toEqual(
							expResHeaders4xxErrors
						);
						expect(response.statusCode).toBe(404);
					});

					it("Returns an XML response if media type in `Accept` request header is `application/xml`", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/invalid",
							headers: {
								accept: "application/xml",
							},
						});

						expect(response.payload).toBe(
							'<?xml version="1.0" encoding="UTF-8"?><response><statusCode>404</statusCode><error>Not Found</error><message>Route GET:/invalid not found</message></response>'
						);
						expect(response.headers).toEqual(
							expResHeaders4xxErrorsXml
						);
						expect(response.statusCode).toBe(404);
					});
				});
			}
		);
	});

	describe("API documentation", () => {
		let config;
		let server;

		beforeAll(async () => {
			Object.assign(process.env, {
				HOST: "localhost",
				PORT: "3000",
				HTTPS_PFX_PASSPHRASE: "",
				HTTPS_PFX_FILE_PATH: "",
				HTTPS_SSL_CERT_PATH: "",
				HTTPS_SSL_KEY_PATH: "",
				HTTPS_HTTP2_ENABLED: "",
				QUERY_STRING_API_KEY_ARRAY: "",
				REDIRECT_URL: "https://pyrusapps.blackpear.com/esp/#!/launch?",
			});
			config = await getConfig();

			// Turn off logging for test runs
			config.fastifyInit.logger = undefined;
			server = Fastify(config.fastifyInit);
			await server.register(startServer, config).listen(config.fastify);
		});

		afterAll(async () => {
			await server.close();
		});

		describe("Content", () => {
			describe("/docs route", () => {
				it("Returns HTML", async () => {
					const response = await server.inject({
						method: "GET",
						url: "/docs",
						headers: {
							accept: "text/html",
						},
					});

					expect(isHtml(response.payload)).toBe(true);
					expect(response.headers).toEqual(expResHeadersHtmlStatic);
					expect(response.statusCode).toBe(200);
				});
			});

			describe("/public route", () => {
				it("Returns image", async () => {
					const response = await server.inject({
						method: "GET",
						url: "/public/images/icons/favicon.ico",
						headers: {
							accept: "*/*",
						},
					});

					expect(response.headers).toEqual(expeResHeadersPublicImage);
					expect(response.statusCode).toBe(200);
				});
			});
		});

		describe("Frontend", () => {
			// Webkit not tested as it is flakey in context of Playwright
			// TODO: use `test.concurrent.each()` once it is no longer experimental
			it.each([
				{ browser: chromium, name: "Chromium" },
				{ browser: firefox, name: "Firefox" },
			])(
				"Renders docs page without error components - $name",
				async ({ browser }) => {
					const browserType = await browser.launch();
					const page = await browserType.newPage();

					await page.goto("http://localhost:3000/docs");
					await expect(page.title()).resolves.toBe(
						"FHIR API Authentication Service | Documentation"
					);
					/**
					 * Checks redoc has not rendered an error component:
					 * https://github.com/Redocly/redoc/blob/main/src/components/ErrorBoundary.tsx
					 */
					const heading = page.locator("h1 >> nth=0");
					await heading.waitFor();

					await expect(heading.textContent()).resolves.not.toMatch(
						/something\s*went\s*wrong/i
					);

					await page.close();
					await browserType.close();
				}
			);
		});
	});

	// TODO: fix this impacting the API documentation `describe` block, and move it back to running before it
	describe("Auth", () => {
		let config;
		let server;
		let currentEnv;

		beforeAll(() => {
			Object.assign(process.env, {
				JWT_JWKS_ARRAY: "",
			});
			currentEnv = { ...process.env };
		});

		const authTests = [
			{
				testName: "Bearer token auth enabled and JWKS JWT auth enabled",
				envVariables: {
					AUTH_BEARER_TOKEN_ARRAY:
						'[{"service": "test", "value": "testtoken"}]',
					JWT_JWKS_ARRAY: `[{"issuerDomain": "${validIssuerUri}"}]`,
				},
			},
			{
				testName:
					"Bearer token auth enabled and JWKS JWT auth disabled",
				envVariables: {
					AUTH_BEARER_TOKEN_ARRAY:
						'[{"service": "test", "value": "testtoken"}]',
					JWT_JWKS_ARRAY: "",
				},
			},
			{
				testName:
					"Bearer token auth disabled and JWKS JWT auth enabled with one JWKS endpoint",
				envVariables: {
					AUTH_BEARER_TOKEN_ARRAY: "",
					JWT_JWKS_ARRAY: `[{"issuerDomain": "${validIssuerUri}"}]`,
				},
			},
			{
				testName:
					"Bearer token auth disabled and JWKS JWT auth enabled with one JWKS endpoint with different aud",
				envVariables: {
					AUTH_BEARER_TOKEN_ARRAY: "",
					JWT_JWKS_ARRAY: `[{"issuerDomain": "${validIssuerUri}", "allowedAudiences": "ydh"}]`,
				},
			},
			{
				testName:
					"Bearer token auth disabled and JWKS JWT auth enabled with two JWKS endpoints (with valid key for one)",
				envVariables: {
					AUTH_BEARER_TOKEN_ARRAY: "",
					JWT_JWKS_ARRAY: `[{"issuerDomain": "${validIssuerUri}"},{"issuerDomain": "${invalidIssuerUri}"}]`,
				},
			},

			{
				testName:
					"Bearer token auth disabled and JWKS JWT auth enabled with one JWKS endpoint (with an invalid key)",
				envVariables: {
					AUTH_BEARER_TOKEN_ARRAY: "",
					JWT_JWKS_ARRAY: `[{"issuerDomain": "${invalidIssuerUri}"}]`,
				},
			},
		];
		describe.each(authTests)("$testName", ({ envVariables }) => {
			beforeAll(async () => {
				Object.assign(process.env, envVariables);
				config = await getConfig();
				// Use Node's core HTTP client as Undici HTTP client throws when used with mocks
				config.forward.undici = undefined;
				config.forward.http = true;

				server = Fastify();
				await server.register(startServer, config).ready();
			});

			afterAll(async () => {
				// Reset the process.env to default after all tests in describe block
				Object.assign(process.env, currentEnv);

				await server.close();
			});

			describe("/forward route", () => {
				if (envVariables.AUTH_BEARER_TOKEN_ARRAY !== "") {
					it("Forwards request to 'FORWARD_URL' using bearer token auth", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/STU3/Patient/5484125",
							headers: {
								accept: "application/fhir+json",
								authorization: "Bearer testtoken",
							},
						});

						expect(JSON.parse(response.payload)).toHaveProperty(
							"resourceType",
							"Patient"
						);
						expect(response.headers).toEqual(expResHeaders);
						expect(response.statusCode).toBe(200);
					});
				}

				it("Fails to forward request to 'FORWARD_URL' using an invalid bearer token/JWT", async () => {
					const response = await server.inject({
						method: "GET",
						url: "/STU3/Patient/5484125",
						headers: {
							accept: "application/fhir+json",
							authorization: "Bearer invalidtoken",
						},
					});

					expect(JSON.parse(response.payload)).toEqual({
						error: "Unauthorized",
						message: "invalid authorization header",
						statusCode: 401,
					});
					expect(response.headers).toEqual(expResHeadersJson);
					expect(response.statusCode).toBe(401);
				});

				it("Fails to forward request to 'FORWARD_URL' Resource if bearer token/JWT is missing", async () => {
					const response = await server.inject({
						method: "GET",
						url: "/STU3/Flag/126844-10",
						headers: {
							accept: "application/fhir+json",
						},
					});

					expect(JSON.parse(response.payload)).toEqual({
						error: "Unauthorized",
						message: "missing authorization header",
						statusCode: 401,
					});
					expect(response.headers).toEqual(expResHeadersJson);
					expect(response.statusCode).toBe(401);
				});

				if (
					envVariables.JWT_JWKS_ARRAY !== "" &&
					envVariables.JWT_JWKS_ARRAY !==
						`[{"issuerDomain": "${invalidIssuerUri}"}]` &&
					envVariables.JWT_JWKS_ARRAY !==
						`[{"issuerDomain": "${validIssuerUri}", "allowedAudiences": "ydh"}]`
				) {
					it("Forwards request to 'FORWARD_URL' using valid JWT against a valid Issuer", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/STU3/Patient/5484125",
							headers: {
								accept: "application/fhir+json",
								authorization: `Bearer ${token}`,
							},
						});

						expect(JSON.parse(response.payload)).toHaveProperty(
							"resourceType",
							"Patient"
						);
						expect(response.headers).toEqual(expResHeaders);
						expect(response.statusCode).toBe(200);
					});
				}

				if (
					envVariables.JWT_JWKS_ARRAY === "" ||
					envVariables.JWT_JWKS_ARRAY ===
						`[{"issuerDomain": "${invalidIssuerUri}"}]` ||
					envVariables.JWT_JWKS_ARRAY ===
						`[{"issuerDomain": "${validIssuerUri}", "allowedAudiences": "ydh"}]`
				) {
					it("Fails to forward request to 'FORWARD_URL' using valid JWT against a invalid Issuer", async () => {
						const response = await server.inject({
							method: "GET",
							url: "/STU3/Patient/5484125",
							headers: {
								accept: "application/fhir+json",
								authorization: `Bearer ${token}`,
							},
						});

						expect(JSON.parse(response.payload)).toEqual({
							error: "Unauthorized",
							message: "invalid authorization header",
							statusCode: 401,
						});
						expect(response.headers).toEqual(expResHeadersJson);
						expect(response.statusCode).toBe(401);
					});
				}
			});
		});
	});

	describe("Error handling", () => {
		let config;
		let server;
		let currentEnv;

		beforeAll(() => {
			Object.assign(process.env, {
				JWT_JWKS_ARRAY: "",
				AUTH_BEARER_TOKEN_ARRAY: "",
			});
			currentEnv = { ...process.env };
		});

		afterEach(async () => {
			// Reset the process.env to default after each test
			Object.assign(process.env, currentEnv);

			await server.close();
		});

		describe("/forward route", () => {
			beforeAll(async () => {
				Object.assign(process.env, {
					FORWARD_URL: "http://0.0.0.125",
				});
				config = await getConfig();
				// Use Node's core HTTP client as Undici HTTP client throws when used with mocks
				config.forward.undici = undefined;
				config.forward.http = true;
			});

			beforeEach(async () => {
				server = Fastify();
				await server.register(startServer, config).ready();
			});

			it("Returns HTTP status code 500 if 'FORWARD_URL' is invalid", async () => {
				const response = await server.inject({
					method: "GET",
					url: "/STU3/Patient/5484125",
					headers: {
						accept: "application/fhir+json",
					},
				});

				expect(JSON.parse(response.payload)).toEqual({
					error: "Internal Server Error",
					message: "Internal Server Error",
					statusCode: 500,
				});
				expect(response.headers).toEqual(expResHeadersJson);
				expect(response.statusCode).toBe(500);
			});
		});
	});
});
