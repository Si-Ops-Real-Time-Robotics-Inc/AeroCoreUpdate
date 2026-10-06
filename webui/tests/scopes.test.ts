import { describe, expect, it } from "vitest";
import {
  canRemove, canEditSystems, canPromote, canPublish, canRead, has, type Me,
} from "@/lib/scopes";

/** The three scope sets this realm actually issues, verified live against Keycloak. */
const admin: Me = {
  id: 9, username: "admin@rtrobotics.com",
  scopes: ["artifact:write", "catalog:delete", "catalog:read", "channel:write", "self", "signing_key", "system:write", "user:admin"],
};
const publisher: Me = {
  id: 15, username: "engineer@rtrobotics.com",
  scopes: ["artifact:write", "catalog:read", "self"],
};
const viewer: Me = {
  id: 175, username: "pilot@rtrobotics.com",
  scopes: ["catalog:read", "self"],
};

describe("publish permission", () => {
  it("lets an admin and a publisher upload", () => {
    expect(canPublish(admin)).toBe(true);
    expect(canPublish(publisher)).toBe(true);
  });

  it("does not let a viewer upload", () => {
    expect(canPublish(viewer)).toBe(false);
  });

  it("assumes nothing before the answer arrives", () => {
    // Rendering the control while `me` is still loading would flash a button a
    // viewer may not use, and hide one an engineer may.
    expect(canPublish(undefined)).toBe(false);
    expect(canPublish(null)).toBe(false);
    expect(canPublish({ id: 1, username: "x", scopes: [] })).toBe(false);
  });
});

describe("the asymmetry this whole model exists for", () => {
  it("gives a publisher the catalog and not the fleet", () => {
    // Uploading fills a catalog nobody is served from; moving a channel is what
    // reaches an aircraft. A leaked publisher credential must not do the second.
    expect(canPublish(publisher)).toBe(true);
    expect(has(publisher, "channel:write")).toBe(false);
  });

  it("gives both to an admin, and only to an admin", () => {
    expect(has(admin, "channel:write")).toBe(true);
    expect(has(viewer, "channel:write")).toBe(false);
  });
});

describe("has", () => {
  it("matches the exact scope, not a prefix of it", () => {
    expect(has(publisher, "artifact:write")).toBe(true);
    expect(has(publisher, "catalog:delete")).toBe(false);
  });
});

/**
 * The three scope sets this realm issues, from src/domain/scopes.js.
 *
 * The asymmetry is the whole point and is worth asserting rather than describing: a publisher
 * may fill the catalog and may not ship it, and only the admin holds both. A screen that
 * offered a publisher a promote button would be offering a button whose only outcome is a
 * refusal.
 */
describe("what each role sees on the systems screen", () => {
  const admin = {
    scopes: [
      "self", "catalog:read", "artifact:write", "channel:write",
      "catalog:delete", "system:write", "user:admin", "signing_key",
    ],
  } as Me;
  const publisher = { scopes: ["self", "catalog:read", "artifact:write"] } as Me;
  const viewer = { scopes: ["self", "catalog:read"] } as Me;

  it("only the admin may move a channel", () => {
    expect(canPromote(admin)).toBe(true);
    expect(canPromote(publisher)).toBe(false);
    expect(canPromote(viewer)).toBe(false);
  });

  it("a publisher may fill the catalog and not ship it", () => {
    expect(canPublish(publisher)).toBe(true);
    expect(canPromote(publisher)).toBe(false);
  });

  it("only the admin may add or remove a system", () => {
    expect(canEditSystems(admin)).toBe(true);
    expect(canEditSystems(publisher)).toBe(false);
    expect(canEditSystems(viewer)).toBe(false);
  });

  it("all three may read, and an account with none may not", () => {
    expect([admin, publisher, viewer].every((me) => canRead(me))).toBe(true);
    // What this server grants every account it creates: the `customer` role maps to nothing.
    expect(canRead({ scopes: [] } as Me)).toBe(false);
    expect(canRead(undefined)).toBe(false);
  });
});

/**
 * Removing a build is a third right, apart from uploading and from moving a channel. A publisher
 * may fill the catalog and may not empty it; nobody but the admin may do either permanently.
 */
describe("who may remove a build", () => {
  const admin = {
    scopes: [
      "self", "catalog:read", "artifact:write", "channel:write",
      "catalog:delete", "system:write", "user:admin", "signing_key",
    ],
  } as Me;
  const publisher = { scopes: ["self", "catalog:read", "artifact:write"] } as Me;
  const viewer = { scopes: ["self", "catalog:read"] } as Me;

  it("only the admin", () => {
    expect(canRemove(admin)).toBe(true);
    expect(canRemove(publisher)).toBe(false);
    expect(canRemove(viewer)).toBe(false);
  });

  it("not an account with no scopes, nor one not loaded yet", () => {
    expect(canRemove({ scopes: [] } as unknown as Me)).toBe(false);
    expect(canRemove(undefined)).toBe(false);
  });
});
