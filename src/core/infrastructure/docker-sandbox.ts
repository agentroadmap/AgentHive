/**
 * Docker Sandbox Provisioning Service
 *
 * Implements STATE-092: Core infrastructure for the Cubic Architecture.
 * Provides an API to spin up, monitor, and destroy isolated Docker containers
 * for agent tasks. Each container is pre-configured with the required tools
 * and limited filesystem access.
 */

interface SandboxRecord {
	id: string;
	agentId: string;
	status: string;
	createdAt: number;
	updatedAt: number;
}

// ──────────────────────────────────────────
// AC#1: Docker Container Provisioning
// ──────────────────────────────────────────

/** Docker image specification */
export interface DockerImage {
	/** Image name (e.g., "node:20-alpine") */
	name: string;
	/** Tag (e.g., "latest", "20-alpine") */
	tag: string;
	/** Full image reference */
	fullRef: string;
}

/** Options for provisioning a sandbox container */
export interface ProvisionOptions {
	/** Docker image to use */
	image: DockerImage;
	/** Agent ID requesting the sandbox */
	agentId: string;
	/** Cubic phase this sandbox is for */
	phase: string;
	/** Host path to mount as workspace */
	workspacePath: string;
	/** Resource limits */
	resources?: ResourceLimits;
	/** Network mode */
	networkMode?: NetworkMode;
	/** Environment variables to inject */
	env?: Record<string, string>;
	/** Command to run (defaults to image entrypoint) */
	cmd?: string[];
}

/** Resource limits for a container */
export interface ResourceLimits {
	/** CPU limit in millicores (1000 = 1 core) */
	cpuMillicores: number;
	/** Memory limit in MB */
	memoryMB: number;
	/** Disk limit in MB */
	diskMB: number;
}

/** Network mode for containers */
export type NetworkMode = "isolated" | "bridge" | "host";

/** Default resource limits */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
	cpuMillicores: 1000, // 1 CPU
	memoryMB: 512,
	diskMB: 1024,
};

/** Status of a provisioned container */
export type ContainerStatus =
	| "provisioning"
	| "running"
	| "paused"
	| "stopping"
	| "stopped"
	| "failed";

/** Container record with runtime details */
export interface ContainerRecord {
	/** Docker container ID */
	containerId: string;
	/** Sandbox ID (maps to SandboxRecord) */
	sandboxId: string;
	/** Agent ID that owns this container */
	agentId: string;
	/** Docker image used */
	image: DockerImage;
	/** Current container status */
	status: ContainerStatus;
	/** Resource limits applied */
	resources: ResourceLimits;
	/** Network mode */
	networkMode: NetworkMode;
	/** Host workspace path mounted */
	workspaceMount: string;
	/** Container internal path where workspace is mounted */
	containerWorkspacePath: string;
	/** Creation timestamp */
	createdAt: number;
	/** Last status update timestamp */
	updatedAt: number;
	/** Container exit code (if stopped) */
	exitCode?: number;
	/** Error message (if failed) */
	error?: string;
}

// ──────────────────────────────────────────
// AC#2: Isolated Networking & Resource Quotas
// ──────────────────────────────────────────

/** Network isolation configuration */
export interface NetworkIsolation {
	/** Whether external network access is allowed */
	allowExternal: boolean;
	/** Allowed host ports (if any) */
	allowedHosts: string[];
	/** DNS servers to use */
	dnsServers: string[];
	/** Whether to create a dedicated network for this container */
	dedicatedNetwork: boolean;
}

/** Default isolated network config */
export const DEFAULT_NETWORK_ISOLATION: NetworkIsolation = {
	allowExternal: false,
	allowedHosts: [],
	dnsServers: ["8.8.8.8", "8.8.4.4"],
	dedicatedNetwork: true,
};

// ──────────────────────────────────────────
// AC#3: Workspace Volume Mounting
// ──────────────────────────────────────────

/** Volume mount specification */
export interface VolumeMount {
	/** Host path */
	hostPath: string;
	/** Container path */
	containerPath: string;
	/** Mount mode: read-only or read-write */
	mode: "ro" | "rw";
	/** Type of mount */
	type: "bind" | "volume" | "tmpfs";
}

/** Create workspace volume mount config */
export function createWorkspaceMount(
	hostPath: string,
	containerPath: string = "/workspace",
): VolumeMount {
	return {
		hostPath,
		containerPath,
		mode: "rw",
		type: "bind",
	};
}

// ──────────────────────────────────────────
// AC#4: Sandbox Registry Integration
// ──────────────────────────────────────────

/** Sandbox registry entry with Docker-specific fields */
export interface DockerSandboxEntry extends SandboxRecord {
	/** Associated Docker container ID */
	dockerContainerId: string;
	/** Image used */
	imageRef: string;
	/** Resource limits */
	resources: ResourceLimits;
	/** Network mode */
	networkMode: NetworkMode;
	/** Workspace mount path on host */
	workspacePath: string;
}

// ──────────────────────────────────────────
// AC#5: Automatic Cleanup
// ──────────────────────────────────────────

/** Cleanup policy for abandoned sandboxes */
export interface CleanupPolicy {
	/** Max idle time in ms before a sandbox is considered stale */
	maxIdleMs: number;
	/** Max lifetime in ms (regardless of activity) */
	maxLifetimeMs: number;
	/** How often to run cleanup sweep in ms */
	sweepIntervalMs: number;
	/** Grace period in ms before force-stopping a stale container */
	gracePeriodMs: number;
}

/** Default cleanup policy */
export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
	maxIdleMs: 30 * 60 * 1000, // 30 minutes
	maxLifetimeMs: 4 * 60 * 60 * 1000, // 4 hours
	sweepIntervalMs: 5 * 60 * 1000, // 5 minutes
	gracePeriodMs: 2 * 60 * 1000, // 2 minutes
};

/** Result of a cleanup sweep */
export interface CleanupResult {
	/** Number of containers checked */
	checked: number;
	/** Number of containers stopped and removed */
	removed: number;
	/** IDs of removed containers */
	removedIds: string[];
	/** Timestamp of the sweep */
	timestamp: number;
}

// ──────────────────────────────────────────
// Docker Sandbox Service
// ──────────────────────────────────────────

/**
 * DockerSandboxService — manages Docker containers for agent sandboxes.
 *
 * Provides provisioning, monitoring, and cleanup of isolated containers
 * for the Cubic Architecture.
 */
export class DockerSandboxService {
	private containers: Map<string, ContainerRecord> = new Map();
	private cleanupPolicy: CleanupPolicy;
	private nextContainerNum: number = 1;

	constructor(cleanupPolicy?: CleanupPolicy) {
		this.cleanupPolicy = cleanupPolicy || DEFAULT_CLEANUP_POLICY;
	}

	// ──────────────────────────────────────────
	// AC#1: Container Provisioning
	// ──────────────────────────────────────────

	/**
	 * Generate a sandbox ID for a new container.
	 */
	private generateSandboxId(): string {
		const num = this.nextContainerNum++;
		return `sbx-${Date.now()}-${num.toString(36).padStart(4, "0")}`;
	}

	/**
	 * Create a Docker image reference.
	 */
	createImage(name: string, tag: string = "latest"): DockerImage {
		return { name, tag, fullRef: `${name}:${tag}` };
	}

	/**
	 * Provision a new sandbox container.
	 *
	 * Returns the ContainerRecord if successful, or throws on failure.
	 * This is a dry-run implementation — it creates the record without
	 * actually calling Docker (to be implemented by a Docker SDK adapter).
	 */
	provision(options: ProvisionOptions): ContainerRecord {
		const sandboxId = this.generateSandboxId();
		const now = Date.now();

		const resources = options.resources || { ...DEFAULT_RESOURCE_LIMITS };
		const networkMode = options.networkMode || "isolated";
		const workspaceMount = createWorkspaceMount(options.workspacePath);

		const record: ContainerRecord = {
			containerId: `docker-${sandboxId}`,
			sandboxId,
			agentId: options.agentId,
			image: options.image,
			status: "provisioning",
			resources,
			networkMode,
			workspaceMount: options.workspacePath,
			containerWorkspacePath: workspaceMount.containerPath,
			createdAt: now,
			updatedAt: now,
		};

		// Simulate provisioning (in real implementation, this would call Docker API)
		record.status = "running";
		this.containers.set(record.containerId, record);

		return record;
	}

	/**
	 * Get container by ID.
	 */
	getContainer(containerId: string): ContainerRecord | undefined {
		return this.containers.get(containerId);
	}

	/**
	 * Get all containers.
	 */
	listContainers(): ContainerRecord[] {
		return Array.from(this.containers.values());
	}

	/**
	 * Get containers for a specific agent.
	 */
	getAgentContainers(agentId: string): ContainerRecord[] {
		return Array.from(this.containers.values()).filter(
			(c) => c.agentId === agentId,
		);
	}

	// ──────────────────────────────────────────
	// AC#2: Resource & Network Management
	// ──────────────────────────────────────────

	/**
	 * Get resource usage summary across all running containers.
	 */
	getResourceUsage(): {
		totalCpu: number;
		totalMemory: number;
		runningCount: number;
	} {
		const running = Array.from(this.containers.values()).filter(
			(c) => c.status === "running",
		);
		return {
			totalCpu: running.reduce((sum, c) => sum + c.resources.cpuMillicores, 0),
			totalMemory: running.reduce((sum, c) => sum + c.resources.memoryMB, 0),
			runningCount: running.length,
		};
	}

	/**
	 * Update container status.
	 */
	updateStatus(
		containerId: string,
		status: ContainerStatus,
		exitCode?: number,
	): boolean {
		const container = this.containers.get(containerId);
		if (!container) return false;

		container.status = status;
		container.updatedAt = Date.now();
		if (exitCode !== undefined) {
			container.exitCode = exitCode;
		}
		return true;
	}

	// ──────────────────────────────────────────
	// AC#3: Workspace Volume Management
	// ──────────────────────────────────────────

	/**
	 * Create volume mounts for a container including workspace.
	 */
	createVolumeMounts(
		workspacePath: string,
		additionalMounts?: VolumeMount[],
	): VolumeMount[] {
		const mounts: VolumeMount[] = [createWorkspaceMount(workspacePath)];

		if (additionalMounts) {
			mounts.push(...additionalMounts);
		}

		return mounts;
	}

	// ──────────────────────────────────────────
	// AC#5: Automatic Cleanup
	// ──────────────────────────────────────────

	/**
	 * Check if a container is stale based on cleanup policy.
	 */
	isContainerStale(container: ContainerRecord): boolean {
		const now = Date.now();

		// Check idle timeout
		const idleTime = now - container.updatedAt;
		if (idleTime > this.cleanupPolicy.maxIdleMs) {
			return true;
		}

		// Check max lifetime
		const lifetime = now - container.createdAt;
		if (lifetime > this.cleanupPolicy.maxLifetimeMs) {
			return true;
		}

		return false;
	}

	/**
	 * Run a cleanup sweep — identifies and removes stale containers.
	 * Returns a summary of what was cleaned up.
	 */
	runCleanup(): CleanupResult {
		const result: CleanupResult = {
			checked: 0,
			removed: 0,
			removedIds: [],
			timestamp: Date.now(),
		};

		for (const [id, container] of this.containers) {
			result.checked++;

			if (container.status === "running" || container.status === "paused") {
				if (this.isContainerStale(container)) {
					container.status = "stopping";
					container.updatedAt = Date.now();

					// In real implementation, this would call docker.stop() then docker.remove()
					container.status = "stopped";
					this.containers.delete(id);

					result.removed++;
					result.removedIds.push(id);
				}
			}
		}

		return result;
	}

	/**
	 * Stop and remove a specific container.
	 */
	stopContainer(containerId: string): boolean {
		const container = this.containers.get(containerId);
		if (!container) return false;

		container.status = "stopped";
		this.containers.delete(containerId);
		return true;
	}

	/**
	 * Get the cleanup policy.
	 */
	getCleanupPolicy(): CleanupPolicy {
		return { ...this.cleanupPolicy };
	}

	/**
	 * Update the cleanup policy.
	 */
	setCleanupPolicy(policy: Partial<CleanupPolicy>): void {
		this.cleanupPolicy = { ...this.cleanupPolicy, ...policy };
	}
}

// ──────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────

/** Create provision options with defaults */
export function createProvisionOptions(
	imageName: string,
	agentId: string,
	phase: string,
	workspacePath: string,
	overrides?: Partial<ProvisionOptions>,
): ProvisionOptions {
	return {
		image: {
			name: imageName.split(":")[0],
			tag: imageName.split(":")[1] || "latest",
			fullRef: imageName,
		},
		agentId,
		phase,
		workspacePath,
		resources: { ...DEFAULT_RESOURCE_LIMITS },
		networkMode: "isolated",
		env: {},
		...overrides,
	};
}
