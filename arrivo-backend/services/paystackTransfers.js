// Thin Paystack client for paying drivers: bank list, account name lookup,
// transfer recipients and transfers. Everything here talks to Paystack and
// nothing else, so tests replace it with _setClient(fake).
//
// Needs PAYSTACK_SECRET_KEY, and on the Paystack dashboard: Transfers enabled
// and "Confirm transfers before sending" (OTP) turned OFF, otherwise every
// transfer waits for an OTP a person must type and nothing is automatic.

const axios = require("axios");

const BASE = "https://api.paystack.co";

class PaystackError extends Error {
  constructor(message, { status = null, network = false, code = null } = {}) {
    super(message);
    this.name = "PaystackError";
    this.status = status;       // HTTP status, null for a network failure
    this.network = network;     // true when we do not know whether Paystack got it
    this.code = code;
  }
}

const real = {
  async call(method, path, { params, data } = {}) {
    if (!process.env.PAYSTACK_SECRET_KEY) throw new PaystackError("PAYSTACK_SECRET_KEY is not set", { status: 503 });
    try {
      const res = await axios({
        method, url: `${BASE}${path}`, params, data, timeout: 20000,
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      });
      return res.data;
    } catch (err) {
      if (err.response) {
        throw new PaystackError(err.response.data?.message || `Paystack error ${err.response.status}`, { status: err.response.status, code: err.response.data?.code || null });
      }
      throw new PaystackError(err.message || "Network error", { network: true });
    }
  },
  async listBanks() {
    const r = await this.call("get", "/bank", { params: { country: "nigeria", currency: "NGN", perPage: 200 } });
    return (r.data || []).filter((b) => b.active !== false).map((b) => ({ code: b.code, name: b.name }));
  },
  async resolveAccount(accountNumber, bankCode) {
    const r = await this.call("get", "/bank/resolve", { params: { account_number: accountNumber, bank_code: bankCode } });
    return { accountName: r.data.account_name, accountNumber: r.data.account_number };
  },
  async createRecipient({ name, accountNumber, bankCode }) {
    const r = await this.call("post", "/transferrecipient", {
      data: { type: "nuban", name, account_number: accountNumber, bank_code: bankCode, currency: "NGN" },
    });
    return { recipientCode: r.data.recipient_code };
  },
  async initiateTransfer({ amountNaira, recipientCode, reference, reason }) {
    const r = await this.call("post", "/transfer", {
      data: { source: "balance", amount: Math.round(amountNaira * 100), recipient: recipientCode, reference, reason, currency: "NGN" },
    });
    return { status: r.data.status, transferCode: r.data.transfer_code };
  },
  async verifyTransfer(reference) {
    const r = await this.call("get", `/transfer/verify/${encodeURIComponent(reference)}`);
    return { status: r.data.status, transferCode: r.data.transfer_code };
  },
};

let client = real;
const api = new Proxy({}, { get: (_, key) => (...a) => client[key](...a) });

module.exports = { api, PaystackError, _setClient: (c) => { client = c || real; } };
