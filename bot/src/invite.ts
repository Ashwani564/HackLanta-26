// Invite friends by sharing their contact card: register them as a Photon
// user (required on shared-pool plans), then text them an intro.
const id = process.env.SPECTRUM_PROJECT_ID!;
const secret = process.env.SPECTRUM_PROJECT_SECRET!;
const BASE = `https://spectrum.photon.codes/projects/${id}/users/`;
const auth = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

export type PhotonUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string;
  assignedPhoneNumber?: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.succeed) throw new Error(body.message ?? `Photon API ${res.status}`);
  return body.data as T;
}

export const listUsers = () => api<{ users: PhotonUser[] }>(BASE).then((d) => d.users);

export async function findUser(phone: string) {
  return (await listUsers()).find((u) => u.phoneNumber === phone);
}

/** Idempotent: re-registering an existing number returns the same user. */
export function registerUser(phone: string, firstName?: string, lastName?: string) {
  return api<PhotonUser>(BASE, {
    method: "POST",
    body: JSON.stringify({ type: "shared", phoneNumber: phone, firstName: firstName ?? null, lastName: lastName ?? null }),
  });
}

export async function removeUser(phone: string) {
  const user = await findUser(phone);
  if (user) await api(`${BASE}${user.id}/`, { method: "DELETE" });
  return !!user;
}

/** Best-effort E.164: keeps a leading +, otherwise assumes a US number. */
export function toE164(raw: string): string | undefined {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : undefined;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

export const inviteMessage = (friend: string | undefined, inviter: string) =>
  `Hey${friend ? ` ${friend}` : ""}! 👋 ${inviter} invited you to plan food together. ` +
  `I help pick what to eat based on your diet, allergies, calories and budget. ` +
  `Any allergies or diet I should know about? (Reply STOP to opt out.)`;
