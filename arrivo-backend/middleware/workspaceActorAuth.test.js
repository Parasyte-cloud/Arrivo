const assert = require("assert");

process.env
  .RIDEARRIVO_WORKSPACE_SERVICE_SECRET =
  "workspace-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

const {
  signWorkspaceActor,
} = require("../services/workspaceActor");

const {
  requireWorkspaceActor,
} = require("./workspaceActorAuth");

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

function response() {
  return {
    statusCode: null,
    body: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(body) {
      this.body = body;
      return this;
    },
  };
}

let pass = 0;

function test(name, fn) {
  fn();
  console.log(`PASS: ${name}`);
  pass += 1;
}

test(
  "missing actor is rejected",
  () => {
    const req = { headers: {} };
    const res = response();
    let nextCalled = false;

    requireWorkspaceActor(
      req,
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.strictEqual(
      res.statusCode,
      401
    );

    assert.strictEqual(
      nextCalled,
      false
    );
  }
);

test(
  "valid actor reaches next middleware",
  () => {
    const token =
      signWorkspaceActor(actor);

    const req = {
      headers: {
        "x-ridearrivo-workspace-actor":
          token,
      },
    };

    const res = response();
    let nextCalled = false;

    requireWorkspaceActor(
      req,
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.strictEqual(
      nextCalled,
      true
    );

    assert.deepStrictEqual(
      req.workspaceActor,
      actor
    );
  }
);

test(
  "tampered actor is rejected",
  () => {
    const token =
      signWorkspaceActor(actor);

    const req = {
      headers: {
        "x-ridearrivo-workspace-actor":
          `${token}x`,
      },
    };

    const res = response();
    let nextCalled = false;

    requireWorkspaceActor(
      req,
      res,
      () => {
        nextCalled = true;
      }
    );

    assert.strictEqual(
      res.statusCode,
      401
    );

    assert.strictEqual(
      nextCalled,
      false
    );
  }
);

console.log(
  `WORKSPACE_ACTOR_MIDDLEWARE_PASS=${pass}`
);
console.log(
  "WORKSPACE_ACTOR_MIDDLEWARE_FAIL=0"
);
