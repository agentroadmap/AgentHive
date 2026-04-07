/**
 * Tests for proposal-092: Docker Sandbox Provisioning Service
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type CleanupPolicy,
	createProvisionOptions,
	createWorkspaceMount,
	DEFAULT_CLEANUP_POLICY,
	DEFAULT_NETWORK_ISOLATION,
	DEFAULT_RESOURCE_LIMITS,
	DockerSandboxService,
} from "../../src/core/infrastructure/docker-sandbox.ts";

describe("proposal-092: Docker Sandbox Provisioning Service", () => {
	// AC#1: Container Provisioning
	describe("AC#1: Container Provisioning", () => {
		it("creates a Docker image reference", () => {
			const service = new DockerSandboxService();
			const image = service.createImage("node", "20-alpine");
			assert.equal(image.name, "node");
			assert.equal(image.tag, "20-alpine");
			assert.equal(image.fullRef, "node:20-alpine");
		});

		it("defaults tag to latest", () => {
			const service = new DockerSandboxService();
			const image = service.createImage("ubuntu");
			assert.equal(image.tag, "latest");
			assert.equal(image.fullRef, "ubuntu:latest");
		});

		it("provisions a new container", () => {
			const service = new DockerSandboxService();
			const options = createProvisionOptions(
				"node:20-alpine",
				"agent-1",
				"build",
				"/tmp/workspace",
			);

			const container = service.provision(options);

			assert.ok(container.containerId.startsWith("docker-"));
			assert.ok(container.sandboxId.startsWith("sbx-"));
			assert.equal(container.agentId, "agent-1");
			assert.equal(container.image.fullRef, "node:20-alpine");
			assert.equal(container.status, "running");
			assert.equal(container.workspaceMount, "/tmp/workspace");
			assert.equal(container.containerWorkspacePath, "/workspace");
		});

		it("assigns resource limits", () => {
			const service = new DockerSandboxService();
			const options = createProvisionOptions(
				"node:20-alpine",
				"agent-1",
				"build",
				"/tmp/workspace",
			);

			const container = service.provision(options);

			assert.equal(
				container.resources.cpuMillicores,
				DEFAULT_RESOURCE_LIMITS.cpuMillicores,
			);
			assert.equal(
				container.resources.memoryMB,
				DEFAULT_RESOURCE_LIMITS.memoryMB,
			);
		});

		it("can get container by ID", () => {
			const service = new DockerSandboxService();
			const container = service.provision(
				createProvisionOptions("node:20-alpine", "agent-1", "build", "/tmp/ws"),
			);

			const found = service.getContainer(container.containerId);
			assert.ok(found);
			assert.equal(found?.containerId, container.containerId);
		});

		it("lists all containers", () => {
			const service = new DockerSandboxService();
			service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);
			service.provision(
				createProvisionOptions("python:3.12", "a2", "test", "/tmp/2"),
			);

			const all = service.listContainers();
			assert.equal(all.length, 2);
		});

		it("filters containers by agent", () => {
			const service = new DockerSandboxService();
			service.provision(
				createProvisionOptions("node:20-alpine", "agent-1", "build", "/tmp/1"),
			);
			service.provision(
				createProvisionOptions("node:20-alpine", "agent-2", "build", "/tmp/2"),
			);
			service.provision(
				createProvisionOptions("node:20-alpine", "agent-1", "test", "/tmp/3"),
			);

			const agent1 = service.getAgentContainers("agent-1");
			assert.equal(agent1.length, 2);
		});
	});

	// AC#2: Resource & Network Isolation
	describe("AC#2: Resource Quotas & Network Isolation", () => {
		it("has default resource limits", () => {
			assert.equal(DEFAULT_RESOURCE_LIMITS.cpuMillicores, 1000);
			assert.equal(DEFAULT_RESOURCE_LIMITS.memoryMB, 512);
			assert.equal(DEFAULT_RESOURCE_LIMITS.diskMB, 1024);
		});

		it("tracks resource usage", () => {
			const service = new DockerSandboxService();
			service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);
			service.provision(
				createProvisionOptions("node:20-alpine", "a2", "build", "/tmp/2"),
			);

			const usage = service.getResourceUsage();
			assert.equal(usage.runningCount, 2);
			assert.equal(usage.totalCpu, 2000); // 2 * 1000
			assert.equal(usage.totalMemory, 1024); // 2 * 512
		});

		it("resource usage excludes stopped containers", () => {
			const service = new DockerSandboxService();
			const c1 = service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);
			service.provision(
				createProvisionOptions("node:20-alpine", "a2", "build", "/tmp/2"),
			);

			service.stopContainer(c1.containerId);

			const usage = service.getResourceUsage();
			assert.equal(usage.runningCount, 1);
			assert.equal(usage.totalCpu, 1000);
		});

		it("default network is isolated", () => {
			assert.equal(DEFAULT_NETWORK_ISOLATION.allowExternal, false);
			assert.equal(DEFAULT_NETWORK_ISOLATION.dedicatedNetwork, true);
		});

		it("updates container status", () => {
			const service = new DockerSandboxService();
			const container = service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);

			assert.equal(container.status, "running");

			const updated = service.updateStatus(container.containerId, "paused");
			assert.equal(updated, true);
			assert.equal(
				service.getContainer(container.containerId)?.status,
				"paused",
			);
		});

		it("returns false for unknown container", () => {
			const service = new DockerSandboxService();
			assert.equal(service.updateStatus("nonexistent", "paused"), false);
		});
	});

	// AC#3: Workspace Volume Mounting
	describe("AC#3: Workspace Volume Mounting", () => {
		it("creates workspace mount with defaults", () => {
			const mount = createWorkspaceMount("/home/agent/work");

			assert.equal(mount.hostPath, "/home/agent/work");
			assert.equal(mount.containerPath, "/workspace");
			assert.equal(mount.mode, "rw");
			assert.equal(mount.type, "bind");
		});

		it("creates workspace mount with custom container path", () => {
			const mount = createWorkspaceMount("/home/agent/work", "/app/data");
			assert.equal(mount.containerPath, "/app/data");
		});

		it("service creates volume mounts including workspace", () => {
			const service = new DockerSandboxService();
			const mounts = service.createVolumeMounts("/host/path", [
				{ hostPath: "/data", containerPath: "/data", mode: "ro", type: "bind" },
			]);

			assert.equal(mounts.length, 2);
			assert.equal(mounts[0].hostPath, "/host/path");
			assert.equal(mounts[0].mode, "rw");
			assert.equal(mounts[1].mode, "ro");
		});
	});

	// AC#4: Sandbox Registry Integration
	describe("AC#4: Sandbox Registry Integration", () => {
		it("container record has sandbox ID", () => {
			const service = new DockerSandboxService();
			const container = service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);

			assert.ok(container.sandboxId);
			assert.ok(container.sandboxId.startsWith("sbx-"));
		});

		it("container record has image reference", () => {
			const service = new DockerSandboxService();
			const container = service.provision(
				createProvisionOptions("python:3.12-slim", "a1", "test", "/tmp/1"),
			);

			assert.equal(container.image.name, "python");
			assert.equal(container.image.tag, "3.12-slim");
		});

		it("provision options helper creates valid options", () => {
			const options = createProvisionOptions(
				"rust:latest",
				"agent-5",
				"build",
				"/work/rust",
			);

			assert.equal(options.image.fullRef, "rust:latest");
			assert.equal(options.agentId, "agent-5");
			assert.equal(options.phase, "build");
			assert.equal(options.workspacePath, "/work/rust");
		});
	});

	// AC#5: Automatic Cleanup
	describe("AC#5: Automatic Cleanup", () => {
		it("has default cleanup policy", () => {
			assert.equal(DEFAULT_CLEANUP_POLICY.maxIdleMs, 30 * 60 * 1000);
			assert.equal(DEFAULT_CLEANUP_POLICY.maxLifetimeMs, 4 * 60 * 60 * 1000);
			assert.equal(DEFAULT_CLEANUP_POLICY.sweepIntervalMs, 5 * 60 * 1000);
			assert.equal(DEFAULT_CLEANUP_POLICY.gracePeriodMs, 2 * 60 * 1000);
		});

		it("stops and removes a container", () => {
			const service = new DockerSandboxService();
			const container = service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);

			assert.equal(service.listContainers().length, 1);

			const stopped = service.stopContainer(container.containerId);
			assert.equal(stopped, true);
			assert.equal(service.listContainers().length, 0);
		});

		it("returns false when stopping unknown container", () => {
			const service = new DockerSandboxService();
			assert.equal(service.stopContainer("ghost"), false);
		});

		it("detects stale containers", () => {
			const shortPolicy: CleanupPolicy = {
				maxIdleMs: 100, // 100ms
				maxLifetimeMs: 5000,
				sweepIntervalMs: 1000,
				gracePeriodMs: 50,
			};
			const service = new DockerSandboxService(shortPolicy);

			const container = service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);

			// Container should not be stale immediately
			assert.equal(service.isContainerStale(container), false);

			// Wait for idle timeout
			return new Promise((resolve) => {
				setTimeout(() => {
					const updated = service.getContainer(container.containerId)!;
					assert.equal(service.isContainerStale(updated), true);
					resolve(undefined);
				}, 150);
			});
		});

		it("runCleanup removes stale containers", () => {
			const shortPolicy: CleanupPolicy = {
				maxIdleMs: 50,
				maxLifetimeMs: 5000,
				sweepIntervalMs: 1000,
				gracePeriodMs: 10,
			};
			const service = new DockerSandboxService(shortPolicy);

			service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);
			service.provision(
				createProvisionOptions("node:20-alpine", "a2", "build", "/tmp/2"),
			);

			assert.equal(service.listContainers().length, 2);

			return new Promise((resolve) => {
				setTimeout(() => {
					const result = service.runCleanup();
					assert.equal(result.checked, 2);
					assert.equal(result.removed, 2);
					assert.equal(result.removedIds.length, 2);
					assert.equal(service.listContainers().length, 0);
					resolve(undefined);
				}, 100);
			});
		});

		it("runCleanup only removes stale, not active containers", () => {
			const shortPolicy: CleanupPolicy = {
				maxIdleMs: 100,
				maxLifetimeMs: 5000,
				sweepIntervalMs: 1000,
				gracePeriodMs: 10,
			};
			const service = new DockerSandboxService(shortPolicy);

			const _c1 = service.provision(
				createProvisionOptions("node:20-alpine", "a1", "build", "/tmp/1"),
			);

			return new Promise((resolve) => {
				setTimeout(() => {
					// c1 is stale now, add a fresh one
					service.provision(
						createProvisionOptions("node:20-alpine", "a2", "build", "/tmp/2"),
					);

					const result = service.runCleanup();
					assert.equal(result.checked, 2);
					assert.equal(result.removed, 1); // only c1
					assert.equal(service.listContainers().length, 1);
					resolve(undefined);
				}, 150);
			});
		});

		it("can get and update cleanup policy", () => {
			const service = new DockerSandboxService();
			const policy = service.getCleanupPolicy();
			assert.equal(policy.maxIdleMs, DEFAULT_CLEANUP_POLICY.maxIdleMs);

			service.setCleanupPolicy({ maxIdleMs: 60000 });
			assert.equal(service.getCleanupPolicy().maxIdleMs, 60000);
		});
	});
});
