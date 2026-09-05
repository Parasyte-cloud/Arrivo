const jwt = require("jsonwebtoken");

const ISSUER = "ridearrivo-workspace";
const AUDIENCE = "arrivo-backend";

const allowedRoles =
  new Set(["support", "manager", "admin"]);

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secret() {
  const value =
    String(
      process.env
        .RIDEARRIVO_WORKSPACE_SERVICE_SECRET || ""
    );

  if (value.length < 32) {
    throw new Error(
      "Workspace service secret is not configured securely"
    );
  }

  return value;
}

function validate(input) {
  const employeeId =
    String(input.employeeId || "").trim();

  const email =
    String(input.email || "").trim().toLowerCase();

  const role =
    String(input.role || "").trim().toLowerCase();

  const requestId =
    String(input.requestId || "").trim();

  if (!uuid.test(employeeId)) {
    throw new Error("Invalid Workspace employee id");
  }

  if (!email.includes("@")) {
    throw new Error("Invalid Workspace employee email");
  }

  if (!allowedRoles.has(role)) {
    throw new Error("Workspace role is not authorised");
  }

  if (!uuid.test(requestId)) {
    throw new Error("Invalid Workspace request id");
  }

  return {
    employeeId,
    email,
    role,
    requestId,
  };
}

function signWorkspaceActor(input) {
  const actor = validate(input);

  return jwt.sign(
    {
      email: actor.email,
      role: actor.role,
    },
    secret(),
    {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: actor.employeeId,
      jwtid: actor.requestId,
      expiresIn: 120,
    }
  );
}

function verifyWorkspaceActor(token) {
  const payload =
    jwt.verify(
      token,
      secret(),
      {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        maxAge: "300s",
        clockTolerance: 5,
      }
    );

  return validate({
    employeeId: payload.sub,
    email: payload.email,
    role: payload.role,
    requestId: payload.jti,
  });
}

module.exports = {
  signWorkspaceActor,
  verifyWorkspaceActor,
};
