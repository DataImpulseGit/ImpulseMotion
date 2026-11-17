import { afterEach, describe, expect, it } from "vitest";
import { asksForBrowser, moBeltFor, MO_BROWSER_MAX_TURNS, moRelayBase, type MoTurnContext } from "@/lib/mo/turn";
import { mintViewToken, normalizeAddress, parseCookieExport, PUBLISH_RE, readViewToken, siteAllowed } from "../../server/browser.mjs";

const ctx = { clients: [], systemPrompt: "RÈGLES", accountScope: { meta: [], google: [], tiktok: [], unrestricted: false }, dataScope: null } as unknown as MoTurnContext;
const session = { userId: "user_abcdef", role: "consultant", user: { name: "Camille", email: null } };

describe("Mo — navigateur piloté : choix de la ceinture", () => {
  afterEach(() => { delete process.env.MO_BROWSER; });

  it("reconnaît une demande de navigateur, pas une demande de chiffres", () => {
    expect(asksForBrowser("ouvre le navigateur sur Ads Manager")).toBe(true);
    expect(asksForBrowser("lance Chrome et crée la campagne dans l'interface Meta")).toBe(true);
    expect(asksForBrowser("les créas de Naturalia cette semaine")).toBe(false);
    expect(asksForBrowser("le budget Google Ads de TSE")).toBe(false);
  });

  it("reste fermé sans MO_BROWSER=1", () => {
    expect(moBeltFor("ouvre le navigateur", false).name).toBe("mo");
  });

  it("ouvre sa propre ceinture, avec sa session, ses tours et sa consigne", () => {
    process.env.MO_BROWSER = "1";
    const belt = moBeltFor("ouvre le navigateur sur Ads Manager", false);
    expect(belt).toEqual({ name: "browser", servers: ["mo", "browser"] });
    const body = moRelayBase(ctx, session, "board0000001", belt);
    expect(body.sessionKey?.endsWith(":browser")).toBe(true);
    expect(body.maxTurns).toBe(MO_BROWSER_MAX_TURNS);
    expect(body.systemPrompt).toContain("NAVIGATEUR PILOTÉ");
    expect(body.mo).toEqual({ userId: "user_abcdef", boardId: "board0000001", name: "Camille" });
    // The default belt keeps the short prompt and its own session.
    const plain = moRelayBase(ctx, session, "board0000001", moBeltFor("les créas de Naturalia", false));
    expect(plain.systemPrompt).toBe("RÈGLES");
    expect(plain.sessionKey).not.toBe(body.sessionKey);
  });

  it("garde la ceinture navigateur pour les suites quand la carte est sur le tableau, sauf demande de chiffres", () => {
    process.env.MO_BROWSER = "1";
    expect(moBeltFor("c'est bon je suis connecté, continue", false, { browserCard: true }).name).toBe("browser");
    expect(moBeltFor("c'est bon je suis connecté, continue", false).name).toBe("mo");
    expect(moBeltFor("montre les créas de Naturalia", false, { browserCard: true }).name).toBe("mo");
  });
});

describe("Mo — navigateur piloté : garde-fous du relay", () => {
  const secret = "s".repeat(32);

  it("jeton de vue : lié au consultant, au secret et à sa durée", () => {
    const { token } = mintViewToken(secret, "user_abcdef", 1_000_000_000_000);
    expect(readViewToken([secret], token, 1_000_000_000_000)).toBe("user_abcdef");
    expect(readViewToken([secret], token, 1_000_000_000_000 + 31 * 60_000)).toBeNull();
    expect(readViewToken(["x".repeat(32)], token, 1_000_000_000_000)).toBeNull();
    expect(readViewToken([secret], token.replace("user_abcdef", "user_abcdeg"), 1_000_000_000_000)).toBeNull();
    expect(readViewToken([secret], "", 0)).toBeNull();
  });

  it("n'ouvre que les plateformes publicitaires, jamais l'hôte ni un faux domaine", () => {
    expect(normalizeAddress("ads.google.com")).toBe("https://ads.google.com");
    expect(normalizeAddress("http://adsmanager.facebook.com/x")).toBe("https://adsmanager.facebook.com/x");
    for (const bad of ["http://127.0.0.1:3457/health", "localhost:3000", "https://evilfacebook.com", "https://facebook.com.evil.io", "file:///etc/passwd", "https://72-62-29-196.sslip.io/health", ""]) expect(normalizeAddress(bad)).toBeNull();
    expect(siteAllowed("about:blank")).toBe(true);
    expect(siteAllowed("chrome://settings")).toBe(false);
  });

  it("refuse à l'IA les boutons qui publient ou paient, pas ceux qui avancent", () => {
    for (const label of ["Publier", "Publish", "Publier les modifications", "Publish changes", "Passer la commande", "Submit for review", "Activer"]) expect(PUBLISH_RE.test(label)).toBe(true);
    for (const label of ["Suivant", "Créer", "Continuer", "Enregistrer le brouillon", "Publicités", "Fermer"]) expect(PUBLISH_RE.test(label)).toBe(false);
  });

  it("cookies importés : seulement ceux des plateformes, non expirés, au format de Chrome", () => {
    const now = 1_800_000_000_000;
    const json = JSON.stringify([
      { domain: ".facebook.com", name: "c_user", value: "123", path: "/", secure: true, httpOnly: false, sameSite: "no_restriction", expirationDate: now / 1000 + 3600 },
      { domain: "ads.google.com", hostOnly: true, name: "SID", value: "abc", sameSite: "lax", session: true },
      { domain: ".exemple.fr", name: "autre", value: "x" },
      { domain: ".tiktok.com", name: "vieux", value: "x", expirationDate: 1000 },
      { domain: ".facebook.com.evil.io", name: "piege", value: "x" },
    ]);
    const r = parseCookieExport(json, now);
    expect(r.cookies.map((c: { name: string }) => c.name)).toEqual(["c_user", "SID"]);
    expect(r.cookies[0]).toMatchObject({ domain: ".facebook.com", secure: true, sameSite: "None", path: "/" });
    expect(r.cookies[1]).toMatchObject({ domain: "ads.google.com", sameSite: "Lax" });
    expect(r.cookies[1].expires).toBeUndefined();
    expect(r.skipped).toBe(3);
    expect(r.sites).toEqual({ "facebook.com": 1, "google.com": 1 });
    // Netscape cookies.txt
    const txt = "# Netscape HTTP Cookie File\n.facebook.com\tTRUE\t/\tTRUE\t1900000000\txs\tsecret\n#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1900000000\tdatr\tsecret2\n";
    const n = parseCookieExport(txt, now);
    expect(n.cookies.map((c: { name: string; httpOnly: boolean }) => [c.name, c.httpOnly])).toEqual([["xs", false], ["datr", true]]);
    expect(() => parseCookieExport("n'importe quoi", now)).toThrow();
    expect(() => parseCookieExport("", now)).toThrow();
  });
});
