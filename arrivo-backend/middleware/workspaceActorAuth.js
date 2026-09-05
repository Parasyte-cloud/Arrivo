const {
  verifyWorkspaceActor,
} = require("../services/workspaceActor");

function requireWorkspaceActor(
  req,
  res,
  next
) {
  const token =
    (
      req.headers?.[
        "x-ridearrivo-workspace-actor"
      ] || ""
    ).trim();

  if (!token) {
    return res.status(401).json({
      error:
        "Trusted Workspace actor is required",
    });
  }

  try {
    req.workspaceActor =
      verifyWorkspaceActor(token);

    return next();
  } catch {
    return res.status(401).json({
      error:
        "Trusted Workspace actor is invalid",
    });
  }
}

module.exports = {
  requireWorkspaceActor,
};
