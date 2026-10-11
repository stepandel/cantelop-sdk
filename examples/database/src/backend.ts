import { app } from "./cantelop.js";
import { createTask, listTasks } from "./tasks.js";

// This runs in the customer's application backend.
const workspace = app.workspace({ slug: process.argv[2] ?? "default" });
const database = await workspace.database();
try {
  const backendTask = await createTask(database, "Created by the application");
  const session = workspace.session();
  const agentTask = await session.request({ title: "Created by the Session" });
  const tasks = await listTasks(database);
  console.log(JSON.stringify({ backendTask, agentTask, tasks }, null, 2));
} finally {
  database.close();
}
