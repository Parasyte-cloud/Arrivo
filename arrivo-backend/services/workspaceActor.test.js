const assert = require("assert");
const jwt = require("jsonwebtoken");

process.env.RIDEARRIVO_WORKSPACE_SERVICE_SECRET =
  "workspace-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

process.env.JWT_SECRET =
  "ordinary-rider-jwt-secret";

const {
  signWorkspaceActor,
  verifyWorkspaceActor,
} = require("./workspaceActor");

const actor = {
  employeeId:
    "11111111-1111-4111-8111-111111111111",
  email:
    "support.test@ridearrivo.com",
  role:
    "support",
  requestId:
    "22222222-2222-4222-8222-222222222222",
};

let pass = 0;

const test = (name, fn) => {
  fn();
  console.log(`PASS: ${name}`);
  pass += 1;
};

test("valid Support actor verifies", () => {
  const token = signWorkspaceActor(actor);
  assert.deepStrictEqual(
    verifyWorkspaceActor(token),
    actor
  );
});

test("Manager and Admin roles verify", () => {
  for (const role of ["manager", "admin"]) {
    const token =
      signWorkspaceActor({ ...actor, role });

    assert.strictEqual(
      verifyWorkspaceActor(token).role,
      role
    );
  }
});

test("Operations role is rejected", () => {
  assert.throws(() =>
    signWorkspaceActor({
      ...actor,
      role: "operations",
    })
  );
});

test("ordinary rider secret cannot forge actor", () => {
  const forged =
    jwt.sign(
      {
        email: actor.email,
        role: actor.role,
      },
      process.env.JWT_SECRET,
      {
        issuer: "ridearrivo-workspace",
        audience: "arrivo-backend",
        subject: actor.employeeId,
        jwtid: actor.requestId,
        expiresIn: 60,
      }
    );

  assert.throws(() =>
    verifyWorkspaceActor(forged)
  );
});

test("tampered token is rejected", () => {
  const token = signWorkspaceActor(actor);
  const final = token.slice(-1);

  const tampered =
    token.slice(0, -1) +
    (final === "a" ? "b" : "a");

  assert.throws(() =>
    verifyWorkspaceActor(tampered)
  );
});

console.log(`WORKSPACE_ACTOR_PASS=${pass}`);
console.log("WORKSPACE_ACTOR_FAIL=0");
