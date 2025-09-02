export type BalanceReq = { userId: number };
export type BalanceResp = { balance: number };

export type NluReq = { message: string; username?: string; password?: string };
export type NluResp = { reply?: string; quickReplies?: string[]; paymentRequest?: { amount: number; qrUrl: string; ref: string } };

export type RegisterReq = { username: string; password: string };

export type PaymentPrepareReq = { userId: number; amount: number; method: 'qr' | 'promptpay' };
export type PaymentPrepareResp = { ref: string; amount: number; qrUrl: string };

export type PaymentVerifyReq = { ref: string };
export type PaymentVerifyResp = { ok: boolean; amount?: number; ref?: string };

export type UpdateBalanceReq = { userId: number; delta: number };
export type UpdateBalanceResp = { ok: true; balance: number };
