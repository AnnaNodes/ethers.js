/**
 *  About Subclassing the Provider...
 *
 *  @_section: api/providers/abstract-provider: Subclassing Provider  [abstract-provider]
 */
// @TODO
// Event coalescence
//   When we register an event with an async value (e.g. address is a Signer
//   or ENS name), we need to add it immeidately for the Event API, but also
//   need time to resolve the address. Upon resolving the address, we need to
//   migrate the listener to the static event. We also need to maintain a map
//   of Signer/ENS name to address so we can sync respond to listenerCount.
import { getAddress, resolveAddress } from "../address/index.js";
import { ZeroHash } from "../constants/index.js";
import { Contract } from "../contract/index.js";
import { namehash } from "../hash/index.js";
import { Transaction } from "../transaction/index.js";
import { concat, dataLength, dataSlice, hexlify, isHexString, getBigInt, getBytes, getNumber, isCallException, isError, makeError, assert, assertArgument, FetchRequest, toBeArray, toQuantity, defineProperties, EventPayload, resolveProperties, toUtf8String } from "../utils/index.js";
import { EnsResolver } from "./ens-resolver.js";
import { formatBlock, formatLog, formatTransactionReceipt, formatTransactionResponse } from "./format.js";
import { Network } from "./network.js";
import { copyRequest, Block, FeeData, Log, TransactionReceipt, TransactionResponse } from "./provider.js";
import { PollingBlockSubscriber, PollingEventSubscriber, PollingOrphanSubscriber, PollingTransactionSubscriber } from "./subscriber-polling.js";
// Constants
const BN_2 = BigInt(2);
const MAX_CCIP_REDIRECTS = 10;
function isPromise(value) {
    return (value && typeof (value.then) === "function");
}
function getTag(prefix, value) {
    return prefix + ":" + JSON.stringify(value, (k, v) => {
        if (v == null) {
            return "null";
        }
        if (typeof (v) === "bigint") {
            return `bigint:${v.toString()}`;
        }
        if (typeof (v) === "string") {
            return v.toLowerCase();
        }
        // Sort object keys
        if (typeof (v) === "object" && !Array.isArray(v)) {
            const keys = Object.keys(v);
            keys.sort();
            return keys.reduce((accum, key) => {
                accum[key] = v[key];
                return accum;
            }, {});
        }
        return v;
    });
}
export class UnmanagedSubscriber {
    name;
    constructor(name) { defineProperties(this, { name }); }
    start() { }
    stop() { }
    pause(dropWhilePaused) { }
    resume() { }
}
function copy(value) {
    return JSON.parse(JSON.stringify(value));
}
function concisify(items) {
    items = Array.from((new Set(items)).values());
    items.sort();
    return items;
}
async function getSubscription(_event, provider) {
    if (_event == null) {
        throw new Error("invalid event");
    }
    // Normalize topic array info an EventFilter
    if (Array.isArray(_event)) {
        _event = { topics: _event };
    }
    if (typeof (_event) === "string") {
        switch (_event) {
            case "block":
            case "pending":
            case "debug":
            case "network": {
                return { type: _event, tag: _event };
            }
        }
    }
    if (isHexString(_event, 32)) {
        const hash = _event.toLowerCase();
        return { type: "transaction", tag: getTag("tx", { hash }), hash };
    }
    if (_event.orphan) {
        const event = _event;
        // @TODO: Should lowercase and whatnot things here instead of copy...
        return { type: "orphan", tag: getTag("orphan", event), filter: copy(event) };
    }
    if ((_event.address || _event.topics)) {
        const event = _event;
        const filter = {
            topics: ((event.topics || []).map((t) => {
                if (t == null) {
                    return null;
                }
                if (Array.isArray(t)) {
                    return concisify(t.map((t) => t.toLowerCase()));
                }
                return t.toLowerCase();
            }))
        };
        if (event.address) {
            const addresses = [];
            const promises = [];
            const addAddress = (addr) => {
                if (isHexString(addr)) {
                    addresses.push(addr);
                }
                else {
                    promises.push((async () => {
                        addresses.push(await resolveAddress(addr, provider));
                    })());
                }
            };
            if (Array.isArray(event.address)) {
                event.address.forEach(addAddress);
            }
            else {
                addAddress(event.address);
            }
            if (promises.length) {
                await Promise.all(promises);
            }
            filter.address = concisify(addresses.map((a) => a.toLowerCase()));
        }
        return { filter, tag: getTag("event", filter), type: "event" };
    }
    assertArgument(false, "unknown ProviderEvent", "event", _event);
}
function getTime() { return (new Date()).getTime(); }
export class AbstractProvider {
    #subs;
    #plugins;
    // null=unpaused, true=paused+dropWhilePaused, false=paused
    #pausedState;
    #networkPromise;
    #anyNetwork;
    #performCache;
    // The most recent block number if running an event or -1 if no "block" event
    #lastBlockNumber;
    #nextTimer;
    #timers;
    #disableCcipRead;
    // @TODO: This should be a () => Promise<Network> so network can be
    // done when needed; or rely entirely on _detectNetwork?
    constructor(_network) {
        if (_network === "any") {
            this.#anyNetwork = true;
            this.#networkPromise = null;
        }
        else if (_network) {
            const network = Network.from(_network);
            this.#anyNetwork = false;
            this.#networkPromise = Promise.resolve(network);
            setTimeout(() => { this.emit("network", network, null); }, 0);
        }
        else {
            this.#anyNetwork = false;
            this.#networkPromise = null;
        }
        this.#lastBlockNumber = -1;
        this.#performCache = new Map();
        this.#subs = new Map();
        this.#plugins = new Map();
        this.#pausedState = null;
        this.#nextTimer = 1;
        this.#timers = new Map();
        this.#disableCcipRead = false;
    }
    get provider() { return this; }
    get plugins() {
        return Array.from(this.#plugins.values());
    }
    attachPlugin(plugin) {
        if (this.#plugins.get(plugin.name)) {
            throw new Error(`cannot replace existing plugin: ${plugin.name} `);
        }
        this.#plugins.set(plugin.name, plugin.connect(this));
        return this;
    }
    getPlugin(name) {
        return (this.#plugins.get(name)) || null;
    }
    get disableCcipRead() { return this.#disableCcipRead; }
    set disableCcipRead(value) { this.#disableCcipRead = !!value; }
    // Shares multiple identical requests made during the same 250ms
    async #perform(req) {
        // Create a tag
        const tag = getTag(req.method, req);
        let perform = this.#performCache.get(tag);
        if (!perform) {
            perform = this._perform(req);
            this.#performCache.set(tag, perform);
            setTimeout(() => {
                if (this.#performCache.get(tag) === perform) {
                    this.#performCache.delete(tag);
                }
            }, 250);
        }
        return await perform;
    }
    async ccipReadFetch(tx, calldata, urls) {
        if (this.disableCcipRead || urls.length === 0 || tx.to == null) {
            return null;
        }
        const sender = tx.to.toLowerCase();
        const data = calldata.toLowerCase();
        const errorMessages = [];
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            // URL expansion
            const href = url.replace("{sender}", sender).replace("{data}", data);
            // If no {data} is present, use POST; otherwise GET
            //const json: string | null = (url.indexOf("{data}") >= 0) ? null: JSON.stringify({ data, sender });
            //const result = await fetchJson({ url: href, errorPassThrough: true }, json, (value, response) => {
            //    value.status = response.statusCode;
            //    return value;
            //});
            const request = new FetchRequest(href);
            if (url.indexOf("{data}") === -1) {
                request.body = { data, sender };
            }
            this.emit("debug", { action: "sendCcipReadFetchRequest", request, index: i, urls });
            let errorMessage = "unknown error";
            const resp = await request.send();
            try {
                const result = resp.bodyJson;
                if (result.data) {
                    this.emit("debug", { action: "receiveCcipReadFetchResult", request, result });
                    return result.data;
                }
                if (result.message) {
                    errorMessage = result.message;
                }
                this.emit("debug", { action: "receiveCcipReadFetchError", request, result });
            }
            catch (error) { }
            // 4xx indicates the result is not present; stop
            assert(resp.statusCode < 400 || resp.statusCode >= 500, `response not found during CCIP fetch: ${errorMessage}`, "OFFCHAIN_FAULT", { reason: "404_MISSING_RESOURCE", transaction: tx, info: { url, errorMessage } });
            // 5xx indicates server issue; try the next url
            errorMessages.push(errorMessage);
        }
        assert(false, `error encountered during CCIP fetch: ${errorMessages.map((m) => JSON.stringify(m)).join(", ")}`, "OFFCHAIN_FAULT", {
            reason: "500_SERVER_ERROR",
            transaction: tx, info: { urls, errorMessages }
        });
    }
    _wrapBlock(value, network) {
        return new Block(formatBlock(value), this);
    }
    _wrapLog(value, network) {
        return new Log(formatLog(value), this);
    }
    _wrapTransactionReceipt(value, network) {
        return new TransactionReceipt(formatTransactionReceipt(value), this);
    }
    _wrapTransactionResponse(tx, network) {
        return new TransactionResponse(tx, this);
    }
    _detectNetwork() {
        assert(false, "sub-classes must implement this", "UNSUPPORTED_OPERATION", {
            operation: "_detectNetwork"
        });
    }
    // Sub-classes should override this and handle PerformActionRequest requests, calling
    // the super for any unhandled actions.
    async _perform(req) {
        assert(false, `unsupported method: ${req.method}`, "UNSUPPORTED_OPERATION", {
            operation: req.method,
            info: req
        });
    }
    // State
    async getBlockNumber() {
        const blockNumber = getNumber(await this.#perform({ method: "getBlockNumber" }), "%response");
        if (this.#lastBlockNumber >= 0) {
            this.#lastBlockNumber = blockNumber;
        }
        return blockNumber;
    }
    _getAddress(address) {
        return resolveAddress(address, this);
    }
    _getBlockTag(blockTag) {
        if (blockTag == null) {
            return "latest";
        }
        switch (blockTag) {
            case "earliest":
                return "0x0";
            case "latest":
            case "pending":
            case "safe":
            case "finalized":
                return blockTag;
        }
        if (isHexString(blockTag)) {
            if (isHexString(blockTag, 32)) {
                return blockTag;
            }
            return toQuantity(blockTag);
        }
        if (typeof (blockTag) === "number") {
            if (blockTag >= 0) {
                return toQuantity(blockTag);
            }
            if (this.#lastBlockNumber >= 0) {
                return toQuantity(this.#lastBlockNumber + blockTag);
            }
            return this.getBlockNumber().then((b) => toQuantity(b + blockTag));
        }
        assertArgument(false, "invalid blockTag", "blockTag", blockTag);
    }
    _getFilter(filter) {
        // Create a canonical representation of the topics
        const topics = (filter.topics || []).map((t) => {
            if (t == null) {
                return null;
            }
            if (Array.isArray(t)) {
                return concisify(t.map((t) => t.toLowerCase()));
            }
            return t.toLowerCase();
        });
        const blockHash = ("blockHash" in filter) ? filter.blockHash : undefined;
        const resolve = (_address, fromBlock, toBlock) => {
            let address = undefined;
            switch (_address.length) {
                case 0: break;
                case 1:
                    address = _address[0];
                    break;
                default:
                    _address.sort();
                    address = _address;
            }
            if (blockHash) {
                if (fromBlock != null || toBlock != null) {
                    throw new Error("invalid filter");
                }
            }
            const filter = {};
            if (address) {
                filter.address = address;
            }
            if (topics.length) {
                filter.topics = topics;
            }
            if (fromBlock) {
                filter.fromBlock = fromBlock;
            }
            if (toBlock) {
                filter.toBlock = toBlock;
            }
            if (blockHash) {
                filter.blockHash = blockHash;
            }
            return filter;
        };
        // Addresses could be async (ENS names or Addressables)
        let address = [];
        if (filter.address) {
            if (Array.isArray(filter.address)) {
                for (const addr of filter.address) {
                    address.push(this._getAddress(addr));
                }
            }
            else {
                address.push(this._getAddress(filter.address));
            }
        }
        let fromBlock = undefined;
        if ("fromBlock" in filter) {
            fromBlock = this._getBlockTag(filter.fromBlock);
        }
        let toBlock = undefined;
        if ("toBlock" in filter) {
            toBlock = this._getBlockTag(filter.toBlock);
        }
        if (address.filter((a) => (typeof (a) !== "string")).length ||
            (fromBlock != null && typeof (fromBlock) !== "string") ||
            (toBlock != null && typeof (toBlock) !== "string")) {
            return Promise.all([Promise.all(address), fromBlock, toBlock]).then((result) => {
                return resolve(result[0], result[1], result[2]);
            });
        }
        return resolve(address, fromBlock, toBlock);
    }
    _getTransactionRequest(_request) {
        const request = copyRequest(_request);
        const promises = [];
        ["to", "from"].forEach((key) => {
            if (request[key] == null) {
                return;
            }
            const addr = resolveAddress(request[key]);
            if (isPromise(addr)) {
                promises.push((async function () { request[key] = await addr; })());
            }
            else {
                request[key] = addr;
            }
        });
        if (request.blockTag != null) {
            const blockTag = this._getBlockTag(request.blockTag);
            if (isPromise(blockTag)) {
                promises.push((async function () { request.blockTag = await blockTag; })());
            }
            else {
                request.blockTag = blockTag;
            }
        }
        if (promises.length) {
            return (async function () {
                await Promise.all(promises);
                return request;
            })();
        }
        return request;
    }
    async getNetwork() {
        // No explicit network was set and this is our first time
        if (this.#networkPromise == null) {
            // Detect the current network (shared with all calls)
            const detectNetwork = this._detectNetwork().then((network) => {
                this.emit("network", network, null);
                return network;
            }, (error) => {
                // Reset the networkPromise on failure, so we will try again
                if (this.#networkPromise === detectNetwork) {
                    this.#networkPromise = null;
                }
                throw error;
            });
            this.#networkPromise = detectNetwork;
            return (await detectNetwork).clone();
        }
        const networkPromise = this.#networkPromise;
        const [expected, actual] = await Promise.all([
            networkPromise,
            this._detectNetwork() // The actual connected network
        ]);
        if (expected.chainId !== actual.chainId) {
            if (this.#anyNetwork) {
                // The "any" network can change, so notify listeners
                this.emit("network", actual, expected);
                // Update the network if something else hasn't already changed it
                if (this.#networkPromise === networkPromise) {
                    this.#networkPromise = Promise.resolve(actual);
                }
            }
            else {
                // Otherwise, we do not allow changes to the underlying network
                assert(false, `network changed: ${expected.chainId} => ${actual.chainId} `, "NETWORK_ERROR", {
                    event: "changed"
                });
            }
        }
        return expected.clone();
    }
    async getFeeData() {
        const { block, gasPrice } = await resolveProperties({
            block: this.getBlock("latest"),
            gasPrice: ((async () => {
                try {
                    const gasPrice = await this.#perform({ method: "getGasPrice" });
                    return getBigInt(gasPrice, "%response");
                }
                catch (error) { }
                return null;
            })())
        });
        let maxFeePerGas = null, maxPriorityFeePerGas = null;
        if (block && block.baseFeePerGas) {
            // We may want to compute this more accurately in the future,
            // using the formula "check if the base fee is correct".
            // See: https://eips.ethereum.org/EIPS/eip-1559
            maxPriorityFeePerGas = BigInt("1000000000");
            // Allow a network to override their maximum priority fee per gas
            //const priorityFeePlugin = (await this.getNetwork()).getPlugin<MaxPriorityFeePlugin>("org.ethers.plugins.max-priority-fee");
            //if (priorityFeePlugin) {
            //    maxPriorityFeePerGas = await priorityFeePlugin.getPriorityFee(this);
            //}
            maxFeePerGas = (block.baseFeePerGas * BN_2) + maxPriorityFeePerGas;
        }
        return new FeeData(gasPrice, maxFeePerGas, maxPriorityFeePerGas);
    }
    async estimateGas(_tx) {
        let tx = this._getTransactionRequest(_tx);
        if (isPromise(tx)) {
            tx = await tx;
        }
        return getBigInt(await this.#perform({
            method: "estimateGas", transaction: tx
        }), "%response");
    }
    async #call(tx, blockTag, attempt) {
        assert(attempt < MAX_CCIP_REDIRECTS, "CCIP read exceeded maximum redirections", "OFFCHAIN_FAULT", {
            reason: "TOO_MANY_REDIRECTS",
            transaction: Object.assign({}, tx, { blockTag, enableCcipRead: true })
        });
        // This came in as a PerformActionTransaction, so to/from are safe; we can cast
        const transaction = copyRequest(tx);
        try {
            return hexlify(await this._perform({ method: "call", transaction, blockTag }));
        }
        catch (error) {
            // CCIP Read OffchainLookup
            if (!this.disableCcipRead && isCallException(error) && error.data && attempt >= 0 && blockTag === "latest" && transaction.to != null && dataSlice(error.data, 0, 4) === "0x556f1830") {
                const data = error.data;
                const txSender = await resolveAddress(transaction.to, this);
                // Parse the CCIP Read Arguments
                let ccipArgs;
                try {
                    ccipArgs = parseOffchainLookup(dataSlice(error.data, 4));
                }
                catch (error) {
                    assert(false, error.message, "OFFCHAIN_FAULT", {
                        reason: "BAD_DATA", transaction, info: { data }
                    });
                }
                // Check the sender of the OffchainLookup matches the transaction
                assert(ccipArgs.sender.toLowerCase() === txSender.toLowerCase(), "CCIP Read sender mismatch", "CALL_EXCEPTION", {
                    action: "call",
                    data,
                    reason: "OffchainLookup",
                    transaction: transaction,
                    invocation: null,
                    revert: {
                        signature: "OffchainLookup(address,string[],bytes,bytes4,bytes)",
                        name: "OffchainLookup",
                        args: ccipArgs.errorArgs
                    }
                });
                const ccipResult = await this.ccipReadFetch(transaction, ccipArgs.calldata, ccipArgs.urls);
                assert(ccipResult != null, "CCIP Read failed to fetch data", "OFFCHAIN_FAULT", {
                    reason: "FETCH_FAILED", transaction, info: { data: error.data, errorArgs: ccipArgs.errorArgs }
                });
                const tx = {
                    to: txSender,
                    data: concat([ccipArgs.selector, encodeBytes([ccipResult, ccipArgs.extraData])])
                };
                this.emit("debug", { action: "sendCcipReadCall", transaction: tx });
                try {
                    const result = await this.#call(tx, blockTag, attempt + 1);
                    this.emit("debug", { action: "receiveCcipReadCallResult", transaction: Object.assign({}, tx), result });
                    return result;
                }
                catch (error) {
                    this.emit("debug", { action: "receiveCcipReadCallError", transaction: Object.assign({}, tx), error });
                    throw error;
                }
            }
            throw error;
        }
    }
    async #checkNetwork(promise) {
        const { value } = await resolveProperties({
            network: this.getNetwork(),
            value: promise
        });
        return value;
    }
    async call(_tx) {
        const { tx, blockTag } = await resolveProperties({
            tx: this._getTransactionRequest(_tx),
            blockTag: this._getBlockTag(_tx.blockTag)
        });
        return await this.#checkNetwork(this.#call(tx, blockTag, _tx.enableCcipRead ? 0 : -1));
    }
    // Account
    async #getAccountValue(request, _address, _blockTag) {
        let address = this._getAddress(_address);
        let blockTag = this._getBlockTag(_blockTag);
        if (typeof (address) !== "string" || typeof (blockTag) !== "string") {
            [address, blockTag] = await Promise.all([address, blockTag]);
        }
        return await this.#checkNetwork(this.#perform(Object.assign(request, { address, blockTag })));
    }
    async getBalance(address, blockTag) {
        return getBigInt(await this.#getAccountValue({ method: "getBalance" }, address, blockTag), "%response");
    }
    async getTransactionCount(address, blockTag) {
        return getNumber(await this.#getAccountValue({ method: "getTransactionCount" }, address, blockTag), "%response");
    }
    async getCode(address, blockTag) {
        return hexlify(await this.#getAccountValue({ method: "getCode" }, address, blockTag));
    }
    async getStorage(address, _position, blockTag) {
        const position = getBigInt(_position, "position");
        return hexlify(await this.#getAccountValue({ method: "getStorage", position }, address, blockTag));
    }
    // Write
    async broadcastTransaction(signedTx) {
        const { blockNumber, hash, network } = await resolveProperties({
            blockNumber: this.getBlockNumber(),
            hash: this._perform({
                method: "broadcastTransaction",
                signedTransaction: signedTx
            }),
            network: this.getNetwork()
        });
        const tx = Transaction.from(signedTx);
        if (tx.hash !== hash) {
            throw new Error("@TODO: the returned hash did not match");
        }
        return this._wrapTransactionResponse(tx, network).replaceableTransaction(blockNumber);
    }
    async #getBlock(block, includeTransactions) {
        // @TODO: Add CustomBlockPlugin check
        if (isHexString(block, 32)) {
            return await this.#perform({
                method: "getBlock", blockHash: block, includeTransactions
            });
        }
        let blockTag = this._getBlockTag(block);
        if (typeof (blockTag) !== "string") {
            blockTag = await blockTag;
        }
        return await this.#perform({
            method: "getBlock", blockTag, includeTransactions
        });
    }
    // Queries
    async getBlock(block, prefetchTxs) {
        const { network, params } = await resolveProperties({
            network: this.getNetwork(),
            params: this.#getBlock(block, !!prefetchTxs)
        });
        if (params == null) {
            return null;
        }
        return this._wrapBlock(formatBlock(params), network);
    }
    async getTransaction(hash) {
        const { network, params } = await resolveProperties({
            network: this.getNetwork(),
            params: this.#perform({ method: "getTransaction", hash })
        });
        if (params == null) {
            return null;
        }
        return this._wrapTransactionResponse(formatTransactionResponse(params), network);
    }
    async getTransactionReceipt(hash) {
        const { network, params } = await resolveProperties({
            network: this.getNetwork(),
            params: this.#perform({ method: "getTransactionReceipt", hash })
        });
        if (params == null) {
            return null;
        }
        // Some backends did not backfill the effectiveGasPrice into old transactions
        // in the receipt, so we look it up manually and inject it.
        if (params.gasPrice == null && params.effectiveGasPrice == null) {
            const tx = await this.#perform({ method: "getTransaction", hash });
            if (tx == null) {
                throw new Error("report this; could not find tx or effectiveGasPrice");
            }
            params.effectiveGasPrice = tx.gasPrice;
        }
        return this._wrapTransactionReceipt(formatTransactionReceipt(params), network);
    }
    async getTransactionResult(hash) {
        const { result } = await resolveProperties({
            network: this.getNetwork(),
            result: this.#perform({ method: "getTransactionResult", hash })
        });
        if (result == null) {
            return null;
        }
        return hexlify(result);
    }
    // Bloom-filter Queries
    async getLogs(_filter) {
        let filter = this._getFilter(_filter);
        if (isPromise(filter)) {
            filter = await filter;
        }
        const { network, params } = await resolveProperties({
            network: this.getNetwork(),
            params: this.#perform({ method: "getLogs", filter })
        });
        return params.map((p) => this._wrapLog(formatLog(p), network));
    }
    // ENS
    _getProvider(chainId) {
        assert(false, "provider cannot connect to target network", "UNSUPPORTED_OPERATION", {
            operation: "_getProvider()"
        });
    }
    async getResolver(name) {
        return await EnsResolver.fromName(this, name);
    }
    async getAvatar(name) {
        const resolver = await this.getResolver(name);
        if (resolver) {
            return await resolver.getAvatar();
        }
        return null;
    }
    async resolveName(name) {
        const resolver = await this.getResolver(name);
        if (resolver) {
            return await resolver.getAddress();
        }
        return null;
    }
    async lookupAddress(address) {
        address = getAddress(address);
        const node = namehash(address.substring(2).toLowerCase() + ".addr.reverse");
        try {
            const ensAddr = await EnsResolver.getEnsAddress(this);
            const ensContract = new Contract(ensAddr, [
                "function resolver(bytes32) view returns (address)"
            ], this);
            const resolver = await ensContract.resolver(node);
            if (resolver == null || resolver === ZeroHash) {
                return null;
            }
            const resolverContract = new Contract(resolver, [
                "function name(bytes32) view returns (string)"
            ], this);
            const name = await resolverContract.name(node);
            // Failed forward resolution
            const check = await this.resolveName(name);
            if (check !== address) {
                return null;
            }
            return name;
        }
        catch (error) {
            // No data was returned from the resolver
            if (isError(error, "BAD_DATA") && error.value === "0x") {
                return null;
            }
            // Something reerted
            if (isError(error, "CALL_EXCEPTION")) {
                return null;
            }
            throw error;
        }
        return null;
    }
    async waitForTransaction(hash, _confirms, timeout) {
        const confirms = (_confirms != null) ? _confirms : 1;
        if (confirms === 0) {
            return this.getTransactionReceipt(hash);
        }
        return new Promise(async (resolve, reject) => {
            let timer = null;
            const listener = (async (blockNumber) => {
                try {
                    const receipt = await this.getTransactionReceipt(hash);
                    if (receipt != null) {
                        if (blockNumber - receipt.blockNumber + 1 >= confirms) {
                            resolve(receipt);
                            //this.off("block", listener);
                            if (timer) {
                                clearTimeout(timer);
                                timer = null;
                            }
                            return;
                        }
                    }
                }
                catch (error) {
                    console.log("EEE", error);
                }
                this.once("block", listener);
            });
            if (timeout != null) {
                timer = setTimeout(() => {
                    if (timer == null) {
                        return;
                    }
                    timer = null;
                    this.off("block", listener);
                    reject(makeError("timeout", "TIMEOUT", { reason: "timeout" }));
                }, timeout);
            }
            listener(await this.getBlockNumber());
        });
    }
    async waitForBlock(blockTag) {
        assert(false, "not implemented yet", "NOT_IMPLEMENTED", {
            operation: "waitForBlock"
        });
    }
    _clearTimeout(timerId) {
        const timer = this.#timers.get(timerId);
        if (!timer) {
            return;
        }
        if (timer.timer) {
            clearTimeout(timer.timer);
        }
        this.#timers.delete(timerId);
    }
    _setTimeout(_func, timeout) {
        if (timeout == null) {
            timeout = 0;
        }
        const timerId = this.#nextTimer++;
        const func = () => {
            this.#timers.delete(timerId);
            _func();
        };
        if (this.paused) {
            this.#timers.set(timerId, { timer: null, func, time: timeout });
        }
        else {
            const timer = setTimeout(func, timeout);
            this.#timers.set(timerId, { timer, func, time: getTime() });
        }
        return timerId;
    }
    _forEachSubscriber(func) {
        for (const sub of this.#subs.values()) {
            func(sub.subscriber);
        }
    }
    // Event API; sub-classes should override this; any supported
    // event filter will have been munged into an EventFilter
    _getSubscriber(sub) {
        switch (sub.type) {
            case "debug":
            case "network":
                return new UnmanagedSubscriber(sub.type);
            case "block":
                return new PollingBlockSubscriber(this);
            case "event":
                return new PollingEventSubscriber(this, sub.filter);
            case "transaction":
                return new PollingTransactionSubscriber(this, sub.hash);
            case "orphan":
                return new PollingOrphanSubscriber(this, sub.filter);
        }
        throw new Error(`unsupported event: ${sub.type}`);
    }
    _recoverSubscriber(oldSub, newSub) {
        for (const sub of this.#subs.values()) {
            if (sub.subscriber === oldSub) {
                if (sub.started) {
                    sub.subscriber.stop();
                }
                sub.subscriber = newSub;
                if (sub.started) {
                    newSub.start();
                }
                if (this.#pausedState != null) {
                    newSub.pause(this.#pausedState);
                }
                break;
            }
        }
    }
    async #hasSub(event, emitArgs) {
        let sub = await getSubscription(event, this);
        // This is a log that is removing an existing log; we actually want
        // to emit an orphan event for the removed log
        if (sub.type === "event" && emitArgs && emitArgs.length > 0 && emitArgs[0].removed === true) {
            sub = await getSubscription({ orphan: "drop-log", log: emitArgs[0] }, this);
        }
        return this.#subs.get(sub.tag) || null;
    }
    async #getSub(event) {
        const subscription = await getSubscription(event, this);
        // Prevent tampering with our tag in any subclass' _getSubscriber
        const tag = subscription.tag;
        let sub = this.#subs.get(tag);
        if (!sub) {
            const subscriber = this._getSubscriber(subscription);
            const addressableMap = new WeakMap();
            const nameMap = new Map();
            sub = { subscriber, tag, addressableMap, nameMap, started: false, listeners: [] };
            this.#subs.set(tag, sub);
        }
        return sub;
    }
    async on(event, listener) {
        const sub = await this.#getSub(event);
        sub.listeners.push({ listener, once: false });
        if (!sub.started) {
            sub.subscriber.start();
            sub.started = true;
            if (this.#pausedState != null) {
                sub.subscriber.pause(this.#pausedState);
            }
        }
        return this;
    }
    async once(event, listener) {
        const sub = await this.#getSub(event);
        sub.listeners.push({ listener, once: true });
        if (!sub.started) {
            sub.subscriber.start();
            sub.started = true;
            if (this.#pausedState != null) {
                sub.subscriber.pause(this.#pausedState);
            }
        }
        return this;
    }
    async emit(event, ...args) {
        const sub = await this.#hasSub(event, args);
        // If there is not subscription or if a recent emit removed
        // the last of them (which also deleted the sub) do nothing
        if (!sub || sub.listeners.length === 0) {
            return false;
        }
        ;
        const count = sub.listeners.length;
        sub.listeners = sub.listeners.filter(({ listener, once }) => {
            const payload = new EventPayload(this, (once ? null : listener), event);
            try {
                listener.call(this, ...args, payload);
            }
            catch (error) { }
            return !once;
        });
        if (sub.listeners.length === 0) {
            if (sub.started) {
                sub.subscriber.stop();
            }
            this.#subs.delete(sub.tag);
        }
        return (count > 0);
    }
    async listenerCount(event) {
        if (event) {
            const sub = await this.#hasSub(event);
            if (!sub) {
                return 0;
            }
            return sub.listeners.length;
        }
        let total = 0;
        for (const { listeners } of this.#subs.values()) {
            total += listeners.length;
        }
        return total;
    }
    async listeners(event) {
        if (event) {
            const sub = await this.#hasSub(event);
            if (!sub) {
                return [];
            }
            return sub.listeners.map(({ listener }) => listener);
        }
        let result = [];
        for (const { listeners } of this.#subs.values()) {
            result = result.concat(listeners.map(({ listener }) => listener));
        }
        return result;
    }
    async off(event, listener) {
        const sub = await this.#hasSub(event);
        if (!sub) {
            return this;
        }
        if (listener) {
            const index = sub.listeners.map(({ listener }) => listener).indexOf(listener);
            if (index >= 0) {
                sub.listeners.splice(index, 1);
            }
        }
        if (!listener || sub.listeners.length === 0) {
            if (sub.started) {
                sub.subscriber.stop();
            }
            this.#subs.delete(sub.tag);
        }
        return this;
    }
    async removeAllListeners(event) {
        if (event) {
            const { tag, started, subscriber } = await this.#getSub(event);
            if (started) {
                subscriber.stop();
            }
            this.#subs.delete(tag);
        }
        else {
            for (const [tag, { started, subscriber }] of this.#subs) {
                if (started) {
                    subscriber.stop();
                }
                this.#subs.delete(tag);
            }
        }
        return this;
    }
    // Alias for "on"
    async addListener(event, listener) {
        return await this.on(event, listener);
    }
    // Alias for "off"
    async removeListener(event, listener) {
        return this.off(event, listener);
    }
    // Sub-classes should override this to shutdown any sockets, etc.
    // but MUST call this super.shutdown.
    destroy() {
        // Stop all listeners
        this.removeAllListeners();
        // Shut down all tiemrs
        for (const timerId of this.#timers.keys()) {
            this._clearTimeout(timerId);
        }
    }
    get paused() { return (this.#pausedState != null); }
    set paused(pause) {
        if (!!pause === this.paused) {
            return;
        }
        if (this.paused) {
            this.resume();
        }
        else {
            this.pause(false);
        }
    }
    pause(dropWhilePaused) {
        this.#lastBlockNumber = -1;
        if (this.#pausedState != null) {
            if (this.#pausedState == !!dropWhilePaused) {
                return;
            }
            assert(false, "cannot change pause type; resume first", "UNSUPPORTED_OPERATION", {
                operation: "pause"
            });
        }
        this._forEachSubscriber((s) => s.pause(dropWhilePaused));
        this.#pausedState = !!dropWhilePaused;
        for (const timer of this.#timers.values()) {
            // Clear the timer
            if (timer.timer) {
                clearTimeout(timer.timer);
            }
            // Remaining time needed for when we become unpaused
            timer.time = getTime() - timer.time;
        }
    }
    resume() {
        if (this.#pausedState == null) {
            return;
        }
        this._forEachSubscriber((s) => s.resume());
        this.#pausedState = null;
        for (const timer of this.#timers.values()) {
            // Remaining time when we were paused
            let timeout = timer.time;
            if (timeout < 0) {
                timeout = 0;
            }
            // Start time (in cause paused, so we con compute remaininf time)
            timer.time = getTime();
            // Start the timer
            setTimeout(timer.func, timeout);
        }
    }
}
function _parseString(result, start) {
    try {
        const bytes = _parseBytes(result, start);
        if (bytes) {
            return toUtf8String(bytes);
        }
    }
    catch (error) { }
    return null;
}
function _parseBytes(result, start) {
    if (result === "0x") {
        return null;
    }
    try {
        const offset = getNumber(dataSlice(result, start, start + 32));
        const length = getNumber(dataSlice(result, offset, offset + 32));
        return dataSlice(result, offset + 32, offset + 32 + length);
    }
    catch (error) { }
    return null;
}
function numPad(value) {
    const result = toBeArray(value);
    if (result.length > 32) {
        throw new Error("internal; should not happen");
    }
    const padded = new Uint8Array(32);
    padded.set(result, 32 - result.length);
    return padded;
}
function bytesPad(value) {
    if ((value.length % 32) === 0) {
        return value;
    }
    const result = new Uint8Array(Math.ceil(value.length / 32) * 32);
    result.set(value);
    return result;
}
const empty = new Uint8Array([]);
// ABI Encodes a series of (bytes, bytes, ...)
function encodeBytes(datas) {
    const result = [];
    let byteCount = 0;
    // Add place-holders for pointers as we add items
    for (let i = 0; i < datas.length; i++) {
        result.push(empty);
        byteCount += 32;
    }
    for (let i = 0; i < datas.length; i++) {
        const data = getBytes(datas[i]);
        // Update the bytes offset
        result[i] = numPad(byteCount);
        // The length and padded value of data
        result.push(numPad(data.length));
        result.push(bytesPad(data));
        byteCount += 32 + Math.ceil(data.length / 32) * 32;
    }
    return concat(result);
}
const zeros = "0x0000000000000000000000000000000000000000000000000000000000000000";
function parseOffchainLookup(data) {
    const result = {
        sender: "", urls: [], calldata: "", selector: "", extraData: "", errorArgs: []
    };
    assert(dataLength(data) >= 5 * 32, "insufficient OffchainLookup data", "OFFCHAIN_FAULT", {
        reason: "insufficient OffchainLookup data"
    });
    const sender = dataSlice(data, 0, 32);
    assert(dataSlice(sender, 0, 12) === dataSlice(zeros, 0, 12), "corrupt OffchainLookup sender", "OFFCHAIN_FAULT", {
        reason: "corrupt OffchainLookup sender"
    });
    result.sender = dataSlice(sender, 12);
    // Read the URLs from the response
    try {
        const urls = [];
        const urlsOffset = getNumber(dataSlice(data, 32, 64));
        const urlsLength = getNumber(dataSlice(data, urlsOffset, urlsOffset + 32));
        const urlsData = dataSlice(data, urlsOffset + 32);
        for (let u = 0; u < urlsLength; u++) {
            const url = _parseString(urlsData, u * 32);
            if (url == null) {
                throw new Error("abort");
            }
            urls.push(url);
        }
        result.urls = urls;
    }
    catch (error) {
        assert(false, "corrupt OffchainLookup urls", "OFFCHAIN_FAULT", {
            reason: "corrupt OffchainLookup urls"
        });
    }
    // Get the CCIP calldata to forward
    try {
        const calldata = _parseBytes(data, 64);
        if (calldata == null) {
            throw new Error("abort");
        }
        result.calldata = calldata;
    }
    catch (error) {
        assert(false, "corrupt OffchainLookup calldata", "OFFCHAIN_FAULT", {
            reason: "corrupt OffchainLookup calldata"
        });
    }
    // Get the callbackSelector (bytes4)
    assert(dataSlice(data, 100, 128) === dataSlice(zeros, 0, 28), "corrupt OffchainLookup callbaackSelector", "OFFCHAIN_FAULT", {
        reason: "corrupt OffchainLookup callbaackSelector"
    });
    result.selector = dataSlice(data, 96, 100);
    // Get the extra data to send back to the contract as context
    try {
        const extraData = _parseBytes(data, 128);
        if (extraData == null) {
            throw new Error("abort");
        }
        result.extraData = extraData;
    }
    catch (error) {
        assert(false, "corrupt OffchainLookup extraData", "OFFCHAIN_FAULT", {
            reason: "corrupt OffchainLookup extraData"
        });
    }
    result.errorArgs = "sender,urls,calldata,selector,extraData".split(/,/).map((k) => result[k]);
    return result;
}
//# sourceMappingURL=abstract-provider.js.map