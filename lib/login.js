"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const lodash_1 = __importDefault(require("lodash"));
const bluebird_1 = __importDefault(require("bluebird"));
const inquirer_1 = __importDefault(require("inquirer"));
const zlib_1 = __importDefault(require("zlib"));
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const cheerio_1 = __importDefault(require("cheerio"));
const uuid_1 = require("uuid");
const puppeteer_1 = __importDefault(require("puppeteer"));
const querystring_1 = __importDefault(require("querystring"));
const debug_1 = __importDefault(require("debug"));
const CLIError_1 = require("./CLIError");
const awsConfig_1 = require("./awsConfig");
const proxy_agent_1 = __importDefault(require("proxy-agent"));
const https_1 = __importDefault(require("https"));
const paths_1 = require("./paths");
const mkdirp_1 = __importDefault(require("mkdirp"));
const debug = debug_1.default("aws-azure-login");
const WIDTH = 425;
const HEIGHT = 550;
const DELAY_ON_UNRECOGNIZED_PAGE = 1000;
const MAX_UNRECOGNIZED_PAGE_DELAY = 30 * 1000;
// source: https://docs.microsoft.com/en-us/azure/active-directory/hybrid/how-to-connect-sso-quick-start#google-chrome-all-platforms
const AZURE_AD_SSO = "autologon.microsoftazuread-sso.com";
const AWS_SAML_ENDPOINT = "https://signin.aws.amazon.com/saml";
const AWS_CN_SAML_ENDPOINT = "https://signin.amazonaws.cn/saml";
const AWS_GOV_SAML_ENDPOINT = "https://signin.amazonaws-us-gov.com/saml";
/**
 * To proxy the input/output of the Azure login page, it's easiest to run a loop that
 * monitors the state of the page and then perform the corresponding CLI behavior.
 * The states have a name that is used for the debug messages, a selector that is used
 * with puppeteer's page.$(selector) to determine if the state is active, and a handler
 * that is called if the state is active.
 */
const states = [
    {
        name: "username input",
        selector: `input[name="loginfmt"]:not(.moveOffScreen)`,
        async handler(page, _selected, noPrompt, defaultUsername) {
            const error = await page.$(".alert-error");
            if (error) {
                debug("Found error message. Displaying");
                const errorMessage = await page.evaluate((err) => err.textContent, error);
                console.log(errorMessage);
            }
            let username;
            if (noPrompt && defaultUsername) {
                debug("Not prompting user for username");
                username = defaultUsername;
            }
            else {
                debug("Prompting user for username");
                ({ username } = await inquirer_1.default.prompt([
                    {
                        name: "username",
                        message: "Username:",
                        default: defaultUsername,
                    },
                ]));
            }
            debug("Focusing on username input");
            await page.focus(`input[name="loginfmt"]`);
            debug("Clearing input");
            for (let i = 0; i < 100; i++) {
                await page.keyboard.press("Backspace");
            }
            debug("Typing username");
            await page.keyboard.type(username);
            await bluebird_1.default.delay(500);
            debug("Submitting form");
            await page.click("input[type=submit]");
            await bluebird_1.default.delay(500);
            debug("Waiting for submission to finish");
            await Promise.race([
                page.waitForSelector(`input[name=loginfmt].has-error,input[name=loginfmt].moveOffScreen`, { timeout: 60000 }),
                (async () => {
                    await bluebird_1.default.delay(1000);
                    await page.waitForSelector(`input[name=loginfmt]`, {
                        hidden: true,
                        timeout: 60000,
                    });
                })(),
            ]);
        },
    },
    {
        name: "account selection",
        selector: `#aadTile > div > div.table-cell.tile-img > img`,
        async handler(page) {
            debug("Multiple accounts associated with username.");
            const aadTile = await page.$("#aadTileTitle");
            const aadTileMessage = await page.evaluate((aadTile) => aadTile.textContent, aadTile);
            const msaTile = await page.$("#msaTileTitle");
            const msaTileMessage = await page.evaluate((msaTile) => msaTile.textContent, msaTile);
            const accounts = [
                { message: aadTileMessage, selector: "#aadTileTitle" },
                { message: msaTileMessage, selector: "#msaTileTitle" },
            ];
            let account;
            if (accounts.length === 0) {
                throw new CLIError_1.CLIError("No accounts found on account selection screen.");
            }
            else if (accounts.length === 1) {
                account = accounts[0];
            }
            else {
                debug("Asking user to choose account");
                console.log("It looks like this Username is used with more than one account from Microsoft. Which one do you want to use?");
                const answers = await inquirer_1.default.prompt([
                    {
                        name: "account",
                        message: "Account:",
                        type: "list",
                        choices: lodash_1.default.map(accounts, "message"),
                        default: aadTileMessage,
                    },
                ]);
                account = lodash_1.default.find(accounts, ["message", answers.account]);
            }
            if (!account) {
                throw new Error("Unable to find account");
            }
            debug(`Proceeding with account ${account.selector}`);
            await page.click(account.selector);
            await bluebird_1.default.delay(500);
        },
    },
    {
        name: "password input",
        selector: `input[name="Password"]:not(.moveOffScreen),input[name="passwd"]:not(.moveOffScreen)`,
        async handler(page, _selected, noPrompt, _defaultUsername, defaultPassword) {
            const error = await page.$(".alert-error");
            if (error) {
                debug("Found error message. Displaying");
                const errorMessage = await page.evaluate((err) => err.textContent, error);
                console.log(errorMessage);
                defaultPassword = ""; // Password error. Unset the default and allow user to enter it.
            }
            let password;
            if (noPrompt && defaultPassword) {
                debug("Not prompting user for password");
                password = defaultPassword;
            }
            else {
                debug("Prompting user for password");
                ({ password } = await inquirer_1.default.prompt([
                    {
                        name: "password",
                        message: "Password:",
                        type: "password",
                    },
                ]));
            }
            debug("Focusing on password input");
            await page.focus(`input[name="Password"],input[name="passwd"]`);
            debug("Typing password");
            await page.keyboard.type(password);
            debug("Submitting form");
            await page.click("span[class=submit],input[type=submit]");
            debug("Waiting for a delay");
            await bluebird_1.default.delay(500);
        },
    },
    {
        name: "TFA instructions",
        selector: `#idDiv_SAOTCAS_Description`,
        async handler(page, selected) {
            const descriptionMessage = await page.evaluate((description) => description.textContent, selected);
            console.log(descriptionMessage);
            debug("Waiting for response");
            await page.waitForSelector(`#idDiv_SAOTCAS_Description`, {
                hidden: true,
                timeout: 60000,
            });
        },
    },
    {
        name: "TFA failed",
        selector: `#idDiv_SAASDS_Description,#idDiv_SAASTO_Description`,
        async handler(page, selected) {
            const descriptionMessage = await page.evaluate((description) => description.textContent, selected);
            throw new CLIError_1.CLIError(descriptionMessage);
        },
    },
    {
        name: "TFA code input",
        selector: "input[name=otc]:not(.moveOffScreen)",
        async handler(page) {
            const error = await page.$(".alert-error");
            if (error) {
                debug("Found error message. Displaying");
                const errorMessage = await page.evaluate((err) => err.textContent, error);
                console.log(errorMessage);
            }
            else {
                const description = await page.$("#idDiv_SAOTCC_Description");
                const descriptionMessage = await page.evaluate((description) => description.textContent, description);
                console.log(descriptionMessage);
            }
            const { verificationCode } = await inquirer_1.default.prompt([
                {
                    name: "verificationCode",
                    message: "Verification Code:",
                },
            ]);
            debug("Focusing on verification code input");
            await page.focus(`input[name="otc"]`);
            debug("Clearing input");
            for (let i = 0; i < 100; i++) {
                await page.keyboard.press("Backspace");
            }
            debug("Typing verification code");
            await page.keyboard.type(verificationCode);
            debug("Submitting form");
            await page.click("input[type=submit]");
            debug("Waiting for submission to finish");
            await Promise.race([
                page.waitForSelector(`input[name=otc].has-error,input[name=otc].moveOffScreen`, { timeout: 60000 }),
                (async () => {
                    await bluebird_1.default.delay(1000);
                    await page.waitForSelector(`input[name=otc]`, {
                        hidden: true,
                        timeout: 60000,
                    });
                })(),
            ]);
        },
    },
    {
        name: "Remember me",
        selector: `#KmsiDescription`,
        async handler(page, _selected, _noPrompt, _defaultUsername, _defaultPassword, rememberMe) {
            if (rememberMe) {
                debug("Clicking remember me button");
                await page.click("#idSIButton9");
            }
            else {
                debug("Clicking don't remember button");
                await page.click("#idBtn_Back");
            }
            debug("Waiting for a delay");
            await bluebird_1.default.delay(500);
        },
    },
    {
        name: "Service exception",
        selector: "#service_exception_message",
        async handler(page, selected) {
            const descriptionMessage = await page.evaluate((description) => description.textContent, selected);
            throw new CLIError_1.CLIError(descriptionMessage);
        },
    },
];
exports.login = {
    async loginAsync(profileName, mode, disableSandbox, noPrompt, enableChromeNetworkService, awsNoVerifySsl, enableChromeSeamlessSso, noDisableExtensions) {
        let headless, cliProxy;
        if (mode === "cli") {
            headless = true;
            cliProxy = true;
        }
        else if (mode === "gui") {
            headless = false;
            cliProxy = false;
        }
        else if (mode === "debug") {
            headless = false;
            cliProxy = true;
        }
        else {
            throw new CLIError_1.CLIError("Invalid mode");
        }
        const profile = await this._loadProfileAsync(profileName);
        let assertionConsumerServiceURL = AWS_SAML_ENDPOINT;
        if (profile.region && profile.region.startsWith("us-gov")) {
            assertionConsumerServiceURL = AWS_GOV_SAML_ENDPOINT;
        }
        if (profile.region && profile.region.startsWith("cn-")) {
            assertionConsumerServiceURL = AWS_CN_SAML_ENDPOINT;
        }
        console.log("Using AWS SAML endpoint", assertionConsumerServiceURL);
        const loginUrl = await this._createLoginUrlAsync(profile.azure_app_id_uri, profile.azure_tenant_id, assertionConsumerServiceURL);
        const samlResponse = await this._performLoginAsync(loginUrl, headless, disableSandbox, cliProxy, noPrompt, enableChromeNetworkService, profile.azure_default_username, profile.azure_default_password, enableChromeSeamlessSso, profile.azure_default_remember_me, noDisableExtensions);
        const roles = this._parseRolesFromSamlResponse(samlResponse);
        const { role, durationHours } = await this._askUserForRoleAndDurationAsync(roles, noPrompt, profile.azure_default_role_arn, profile.azure_default_duration_hours, profile.aws_account_aliases);
        await this._assumeRoleAsync(profileName, samlResponse, role, durationHours, awsNoVerifySsl, profile.region);
    },
    async loginAll(mode, disableSandbox, noPrompt, enableChromeNetworkService, awsNoVerifySsl, enableChromeSeamlessSso, forceRefresh, noDisableExtensions) {
        const profiles = await awsConfig_1.awsConfig.getAllProfileNames();
        if (!profiles) {
            return;
        }
        for (const profile of profiles) {
            debug(`Check if profile ${profile} is expired or is about to expire`);
            if (!forceRefresh &&
                !(await awsConfig_1.awsConfig.isProfileAboutToExpireAsync(profile))) {
                debug(`Profile ${profile} not yet due for refresh.`);
                continue;
            }
            debug(`Run login for profile: ${profile}`);
            await this.loginAsync(profile, mode, disableSandbox, noPrompt, enableChromeNetworkService, awsNoVerifySsl, enableChromeSeamlessSso, noDisableExtensions);
        }
    },
    // Gather data from environment variables
    _loadProfileFromEnv() {
        const env = {};
        const options = [
            "azure_tenant_id",
            "azure_app_id_uri",
            "azure_default_username",
            "azure_default_password",
            "azure_default_role_arn",
            "azure_default_duration_hours",
        ];
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const envVar = process.env[opt];
            const envVarUpperCase = process.env[opt.toUpperCase()];
            if (envVar) {
                env[opt] = envVar;
            }
            else if (envVarUpperCase) {
                env[opt] = envVarUpperCase;
            }
        }
        debug("Environment");
        debug({
            ...env,
            azure_default_password: "xxxxxxxxxx",
        });
        return env;
    },
    // Load the profile
    async _loadProfileAsync(profileName) {
        const profile = await awsConfig_1.awsConfig.getProfileConfigAsync(profileName);
        if (!profile)
            throw new CLIError_1.CLIError(`Unknown profile '${profileName}'. You must configure it first with --configure.`);
        const env = this._loadProfileFromEnv();
        for (const prop in env) {
            if (env[prop]) {
                profile[prop] = env[prop] === null ? profile[prop] : env[prop];
            }
        }
        if (!profile.azure_tenant_id || !profile.azure_app_id_uri)
            throw new CLIError_1.CLIError(`Profile '${profileName}' is not configured properly.`);
        console.log(`Logging in with profile '${profileName}'...`);
        return profile;
    },
    /**
     * Create the Azure login SAML URL.
     * @param {string} appIdUri - The app ID URI
     * @param {string} tenantId - The Azure tenant ID
     * @param {string} assertionConsumerServiceURL - The AWS SAML endpoint that Azure should send the SAML response to
     * @returns {string} The login URL
     * @private
     */
    _createLoginUrlAsync(appIdUri, tenantId, assertionConsumerServiceURL) {
        debug("Generating UUID for SAML request");
        const id = uuid_1.v4();
        const samlRequest = `
        <samlp:AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:metadata" ID="id${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" IsPassive="false" AssertionConsumerServiceURL="${assertionConsumerServiceURL}" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
            <Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${appIdUri}</Issuer>
            <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"></samlp:NameIDPolicy>
        </samlp:AuthnRequest>
        `;
        debug("Generated SAML request", samlRequest);
        debug("Deflating SAML");
        return new Promise((resolve, reject) => {
            zlib_1.default.deflateRaw(samlRequest, (err, samlBuffer) => {
                if (err) {
                    return reject(err);
                }
                debug("Encoding SAML in base64");
                const samlBase64 = samlBuffer.toString("base64");
                const url = `https://login.microsoftonline.com/${tenantId}/saml2?SAMLRequest=${encodeURIComponent(samlBase64)}`;
                debug("Created login URL", url);
                return resolve(url);
            });
        });
    },
    /**
     * Perform the login using Chrome.
     * @param {string} url - The login URL
     * @param {boolean} headless - True to hide the GUI, false to show it.
     * @param {boolean} disableSandbox - True to disable the Puppeteer sandbox.
     * @param {boolean} cliProxy - True to proxy input/output through the CLI, false to leave it in the GUI
     * @param {bool} [noPrompt] - Enable skipping of user prompting
     * @param {bool} [enableChromeNetworkService] - Enable chrome network service.
     * @param {string} [defaultUsername] - The default username
     * @param {string} [defaultPassword] - The default password
     * @param {bool} [enableChromeSeamlessSso] - chrome seamless SSO
     * @param {bool} [rememberMe] - Enable remembering the session
     * @param {bool} [noDisableExtensions] - True to prevent Puppeteer from disabling Chromium extensions
     * @returns {Promise.<string>} The SAML response.
     * @private
     */
    async _performLoginAsync(url, headless, disableSandbox, cliProxy, noPrompt, enableChromeNetworkService, defaultUsername, defaultPassword, enableChromeSeamlessSso, rememberMe, noDisableExtensions) {
        debug("Loading login page in Chrome");
        let browser;
        try {
            const args = headless
                ? []
                : [`--app=${url}`, `--window-size=${WIDTH},${HEIGHT}`];
            if (disableSandbox)
                args.push("--no-sandbox");
            if (enableChromeNetworkService)
                args.push("--enable-features=NetworkService");
            if (enableChromeSeamlessSso)
                args.push(`--auth-server-whitelist=${AZURE_AD_SSO}`, `--auth-negotiate-delegate-whitelist=${AZURE_AD_SSO}`);
            if (rememberMe) {
                await mkdirp_1.default(paths_1.paths.chromium);
                args.push(`--user-data-dir=${paths_1.paths.chromium}`);
            }
            const ignoreDefaultArgs = noDisableExtensions
                ? ["--disable-extensions"]
                : [];
            browser = await puppeteer_1.default.launch({
                headless,
                args,
                ignoreDefaultArgs,
            });
            // Wait for a bit as sometimes the browser isn't ready.
            await bluebird_1.default.delay(200);
            const pages = await browser.pages();
            const page = pages[0];
            await page.setViewport({ width: WIDTH - 15, height: HEIGHT - 35 });
            // Prevent redirection to AWS
            let samlResponseData;
            const samlResponsePromise = new Promise((resolve) => {
                page.on("request", (req) => {
                    const url = req.url();
                    debug(`Request: ${url}`);
                    if (url === AWS_SAML_ENDPOINT ||
                        url === AWS_GOV_SAML_ENDPOINT ||
                        url === AWS_CN_SAML_ENDPOINT) {
                        resolve();
                        samlResponseData = req.postData();
                        req.respond({
                            status: 200,
                            contentType: "text/plain",
                            body: "",
                        });
                        if (browser) {
                            browser.close();
                        }
                        browser = undefined;
                        debug(`Received SAML response, browser closed`);
                    }
                    else {
                        req.continue();
                    }
                });
            });
            debug("Enabling request interception");
            await page.setRequestInterception(true);
            try {
                if (headless || (!headless && cliProxy)) {
                    debug("Going to login page");
                    await page.goto(url, { waitUntil: "domcontentloaded" });
                }
                else {
                    debug("Waiting for login page to load");
                    await page.waitForNavigation({ waitUntil: "networkidle0" });
                }
            }
            catch (err) {
                // An error will be thrown if you're still logged in cause the page.goto ot waitForNavigation
                // will be a redirect to AWS. That's usually OK
                debug(`Error occured during loading the first page: ${err.message}`);
            }
            if (cliProxy) {
                let totalUnrecognizedDelay = 0;
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    if (samlResponseData)
                        break;
                    let foundState = false;
                    for (let i = 0; i < states.length; i++) {
                        const state = states[i];
                        let selected;
                        try {
                            selected = await page.$(state.selector);
                        }
                        catch (err) {
                            // An error can be thrown if the page isn't in a good state.
                            // If one occurs, try again after another loop.
                            debug(`Error when running state "${state.name}". ${err.toString()}. Retrying...`);
                            break;
                        }
                        if (selected) {
                            foundState = true;
                            debug(`Found state: ${state.name}`);
                            await Promise.race([
                                samlResponsePromise,
                                state.handler(page, selected, noPrompt, defaultUsername, defaultPassword, rememberMe),
                            ]);
                            debug(`Finished state: ${state.name}`);
                            break;
                        }
                    }
                    if (foundState) {
                        totalUnrecognizedDelay = 0;
                    }
                    else {
                        debug("State not recognized!");
                        if (totalUnrecognizedDelay > MAX_UNRECOGNIZED_PAGE_DELAY) {
                            const path = "aws-azure-login-unrecognized-state.png";
                            await page.screenshot({ path });
                            throw new CLIError_1.CLIError(`Unable to recognize page state! A screenshot has been dumped to ${path}. If this problem persists, try running with --mode=gui or --mode=debug`);
                        }
                        totalUnrecognizedDelay += DELAY_ON_UNRECOGNIZED_PAGE;
                        await bluebird_1.default.delay(DELAY_ON_UNRECOGNIZED_PAGE);
                    }
                }
            }
            else {
                console.log("Please complete the login in the opened window");
                await samlResponsePromise;
            }
            if (!samlResponseData) {
                throw new Error("SAML response not found");
            }
            const samlResponse = querystring_1.default.parse(samlResponseData).SAMLResponse;
            debug("Found SAML response", samlResponse);
            if (Array.isArray(samlResponse)) {
                throw new Error("SAML can't be an array");
            }
            return samlResponse;
        }
        finally {
            if (browser) {
                await browser.close();
            }
        }
    },
    /**
     * Parse AWS roles out of the SAML response
     * @param {string} assertion - The SAML assertion
     * @returns {Array.<{roleArn: string, principalArn: string}>} The roles
     * @private
     */
    _parseRolesFromSamlResponse(assertion) {
        debug("Converting assertion from base64 to ASCII");
        const samlText = Buffer.from(assertion, "base64").toString("ascii");
        debug("Converted", samlText);
        debug("Parsing SAML XML");
        const saml = cheerio_1.default.load(samlText, { xmlMode: true });
        debug("Looking for role SAML attribute");
        const roles = saml("Attribute[Name='https://aws.amazon.com/SAML/Attributes/Role']>AttributeValue")
            .map(function () {
            // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
            // @ts-ignore
            const roleAndPrincipal = saml(this).text();
            const parts = roleAndPrincipal.split(",");
            // Role / Principal claims may be in either order
            const [roleIdx, principalIdx] = parts[0].includes(":role/")
                ? [0, 1]
                : [1, 0];
            const roleArn = parts[roleIdx].trim();
            const principalArn = parts[principalIdx].trim();
            return { roleArn, principalArn };
        })
            .get();
        debug("Found roles", roles);
        return roles;
    },
    /**
     * Ask the user for the role they want to use.
     * @param {Array.<{roleArn: string, principalArn: string}>} roles - The roles to pick from
     * @param {bool} [noPrompt] - Enable skipping of user prompting
     * @param {string} [defaultRoleArn] - The default role ARN
     * @param {number} [defaultDurationHours] - The default session duration in hours
     * @returns {Promise.<{role: string, durationHours: number}>} The selected role and duration
     * @private
     */
    async _askUserForRoleAndDurationAsync(roles, noPrompt, defaultRoleArn, defaultDurationHours, aws_account_aliases) {
        let role;
        let durationHours;
        const questions = [];
        if (roles.length === 0) {
            throw new CLIError_1.CLIError("No roles found in SAML response.");
        }
        else if (roles.length === 1) {
            debug("Choosing the only role in response");
            role = roles[0];
        }
        else {
            if (noPrompt && defaultRoleArn) {
                role = lodash_1.default.find(roles, ["roleArn", defaultRoleArn]);
            }
            if (role) {
                debug("Valid role found. No need to ask.");
            }
            else {
                debug("Asking user to choose role");
                let roleDisplayNames = lodash_1.default.map(roles, "roleArn");
                if (aws_account_aliases) {
                    let accounts = aws_account_aliases.split(',');
                    for (let i = 0; i < roleDisplayNames.length; i++) {
                        const accountNo = roleDisplayNames[i].split(':')[4];
                        const accountLabel = accounts.find((account) => account.includes(accountNo));
                        const whitespaces = 40 - (accountLabel ? Math.min(accountLabel.length, 40) : 0);
                        if (defaultRoleArn == roleDisplayNames[i]) {
                            defaultRoleArn = `${accountLabel}${' '.repeat(whitespaces)} => ${roleDisplayNames[i]}`;
                        }
                        roleDisplayNames[i] = `${accountLabel}${' '.repeat(whitespaces)} => ${roleDisplayNames[i]}`;
                    }
                }
                questions.push({
                    name: "role",
                    message: "Role:",
                    type: "list",
                    choices: lodash_1.default.sortBy(roleDisplayNames),
                    default: defaultRoleArn,
                });
            }
        }
        if (noPrompt && defaultDurationHours) {
            debug("Default durationHours found. No need to ask.");
            durationHours = defaultDurationHours;
        }
        else {
            questions.push({
                name: "durationHours",
                message: "Session Duration Hours (up to 12):",
                type: "input",
                default: defaultDurationHours || 1,
                validate: (input) => {
                    input = Number(input);
                    if (input > 0 && input <= 12)
                        return true;
                    return "Duration hours must be between 0 and 12";
                },
            });
        }
        // Don't prompt for questions if not needed, an unneeded TTYWRAP prevents node from exiting when
        // user is logged in and using multiple profiles --all-profiles and --no-prompt
        if (questions.length > 0) {
            const answers = await inquirer_1.default.prompt(questions);
            if (!role)
                role = lodash_1.default.find(roles, ["roleArn", answers.role.split(" => ")[1]]);
            if (!durationHours)
                durationHours = answers.durationHours;
        }
        if (!role) {
            throw new Error(`Unable to find role`);
        }
        return { role, durationHours };
    },
    /**
     * Assume the role.
     * @param {string} profileName - The profile name
     * @param {string} assertion - The SAML assertion
     * @param {string} role - The role to assume
     * @param {number} durationHours - The session duration in hours
     * @param {bool} awsNoVerifySsl - Whether to have the AWS CLI verify SSL
     * @param {string} region - AWS region, if specified
     * @returns {Promise} A promise
     * @private
     */
    async _assumeRoleAsync(profileName, assertion, role, durationHours, awsNoVerifySsl, region) {
        console.log(`Assuming role ${role.roleArn}`);
        if (process.env.https_proxy) {
            aws_sdk_1.default.config.update({
                httpOptions: {
                    agent: proxy_agent_1.default(process.env.https_proxy),
                },
            });
        }
        if (awsNoVerifySsl) {
            aws_sdk_1.default.config.update({
                httpOptions: {
                    agent: new https_1.default.Agent({
                        rejectUnauthorized: false,
                    }),
                },
            });
        }
        if (region) {
            aws_sdk_1.default.config.update({
                region,
            });
        }
        const sts = new aws_sdk_1.default.STS();
        const res = await sts
            .assumeRoleWithSAML({
            PrincipalArn: role.principalArn,
            RoleArn: role.roleArn,
            SAMLAssertion: assertion,
            DurationSeconds: Math.round(durationHours * 60 * 60),
        })
            .promise();
        if (!res.Credentials) {
            debug("Unable to get security credentials from AWS");
            return;
        }
        await awsConfig_1.awsConfig.setProfileCredentialsAsync(profileName, {
            aws_access_key_id: res.Credentials.AccessKeyId,
            aws_secret_access_key: res.Credentials.SecretAccessKey,
            aws_session_token: res.Credentials.SessionToken,
            aws_expiration: res.Credentials.Expiration.toISOString(),
        });
    },
};
