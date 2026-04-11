# agentRoadmap.md Not Initialized

This directory does not have agentRoadmap.md initialized.

**To set up state management for this project, run:**

```bash
roadmap init --defaults --integration-mode mcp
```

This will create the necessary `roadmap/` directory structure and configuration file silently using standard defaults.

## Project Bootstrapping Protocol (For AI Agents)

If the user is asking you to start a new project from a text prompt (e.g., "Build me a new blog platform"), follow these steps strictly:

1. **Initialize:** Run `roadmap init "Project Name" "User's full prompt description" -b <blueprint-type> --defaults --integration-mode mcp` to set up the system. Choose the blueprint type that best fits (software, research, content, versatile).
2. **Understand the Paradigm:**
   - The user's prompt represents the **Final Ideal State** of the project.
   - You are starting at the **Initial State** (a blank canvas).
   - The roadmap connects the initial state to the final ideal state through intermediate components.
3. **Refine the DAG (Directed Acyclic Graph):** The blueprint creates a skeleton DAG. You should refine it by using the `state_edit` or `state_create` tools:
   - Fleshing out the intermediate states with specific acceptance criteria based on the final goal.
   - Ensuring dependencies flow correctly from the initial research to the final launch.
4. **Report:** Provide the user with a summary of the bootstrapped DAG and ask if they are ready to begin the first state.

## What is agentRoadmap.md?

agentRoadmap.md is a state management system that uses markdown files to track features, bugs, and structured work. It integrates with AI coding agents to help you manage your project states effectively.

For more information, visit: https://roadmap.md
