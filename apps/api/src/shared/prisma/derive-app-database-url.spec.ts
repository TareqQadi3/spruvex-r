import { deriveAppDatabaseUrl } from "./derive-app-database-url";

describe("deriveAppDatabaseUrl", () => {
  const admin = "postgresql://neondb_owner:ownerpw@ep-x.neon.tech/neondb?sslmode=require";

  it("derives the spruvex_app URL from the admin URL + bootstrap password", () => {
    const env: NodeJS.ProcessEnv = { ADMIN_DATABASE_URL: admin, BOOTSTRAP_APP_ROLE_PASSWORD: "p@ss/w+rd=" };
    deriveAppDatabaseUrl(env);
    const url = new URL(env.DATABASE_URL!);
    expect(url.username).toBe("spruvex_app");
    expect(decodeURIComponent(url.password)).toBe("p@ss/w+rd=");
    expect(url.host).toBe("ep-x.neon.tech");
    expect(url.pathname).toBe("/neondb");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("never overrides an explicit DATABASE_URL", () => {
    const env: NodeJS.ProcessEnv = {
      ADMIN_DATABASE_URL: admin,
      BOOTSTRAP_APP_ROLE_PASSWORD: "x",
      DATABASE_URL: "postgresql://custom:pw@host/db",
    };
    deriveAppDatabaseUrl(env);
    expect(env.DATABASE_URL).toBe("postgresql://custom:pw@host/db");
  });

  it("does nothing without the bootstrap password", () => {
    const env: NodeJS.ProcessEnv = { ADMIN_DATABASE_URL: admin };
    deriveAppDatabaseUrl(env);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("strips Neon's channel_binding param Prisma does not support", () => {
    const env: NodeJS.ProcessEnv = {
      ADMIN_DATABASE_URL: `${admin}&channel_binding=require`,
      BOOTSTRAP_APP_ROLE_PASSWORD: "x",
    };
    deriveAppDatabaseUrl(env);
    expect(env.ADMIN_DATABASE_URL).not.toContain("channel_binding");
    expect(env.DATABASE_URL).not.toContain("channel_binding");
    expect(new URL(env.ADMIN_DATABASE_URL!).searchParams.get("sslmode")).toBe("require");
  });
});
