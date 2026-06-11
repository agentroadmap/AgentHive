/**
 * P1351 AC-7: Cockpit Agency Roster component
 *
 * Displays agencies in a hierarchical tree view, grouped by parent_agency_id.
 * Shows parent-child relationships and child counts per parent.
 */

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

interface Agency {
  agency_id: string;
  display_name: string;
  parent_agency_id: string | null;
  provider: string;
  host_id: string;
}

interface AgencyGroup {
  parent: Agency | null;
  children: Agency[];
}

const CockpitAgencyRoster: React.FC = () => {
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [groups, setGroups] = useState<Map<string | null, AgencyGroup>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    new Set(),
  );

  const fetchAgencies = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);

      const response = await fetch("/api/agencies");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data: Agency[] = await response.json();
      setAgencies(data);

      // Group agencies by parent_agency_id
      const newGroups = new Map<string | null, AgencyGroup>();

      // First pass: initialize root group
      newGroups.set(null, { parent: null, children: [] });

      // Add agencies
      for (const agency of data) {
        if (!agency.parent_agency_id) {
          // Root agency
          newGroups.get(null)!.children.push(agency);
        } else {
          // Child agency
          if (!newGroups.has(agency.parent_agency_id)) {
            newGroups.set(agency.parent_agency_id, {
              parent: null,
              children: [],
            });
          }
          newGroups.get(agency.parent_agency_id)!.children.push(agency);
        }
      }

      // Second pass: link parent references
      for (const [_parentId, group] of newGroups) {
        if (group.children.length > 0 && group.children[0].parent_agency_id) {
          const parentId = group.children[0].parent_agency_id;
          const parentAgency = data.find((a) => a.agency_id === parentId);
          if (parentAgency) {
            group.parent = parentAgency;
          }
        }
      }

      setGroups(newGroups);
    } catch (err) {
      console.error("Failed to fetch agencies:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load agencies",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgencies();
  }, [fetchAgencies]);

  const toggleExpanded = (parentId: string | null) => {
    const newExpanded = new Set(expandedParents);
    if (newExpanded.has(parentId ?? "root")) {
      newExpanded.delete(parentId ?? "root");
    } else {
      newExpanded.add(parentId ?? "root");
    }
    setExpandedParents(newExpanded);
  };

  if (loading) {
    return (
      <div className="flex flex-col justify-center items-center h-64 space-y-4">
        <LoadingSpinner size="lg" text="" />
        <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
          Loading agencies...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
          <p className="text-red-600 dark:text-red-400 font-medium">Error</p>
          <p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
          <button
            type="button"
            onClick={fetchAgencies}
            className="mt-4 px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const rootGroup = groups.get(null);
  const totalAgencies = agencies.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Agency Roster ({totalAgencies})
        </h1>
        <button
          type="button"
          onClick={fetchAgencies}
          className="px-3 py-1 text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-900/50"
        >
          Refresh
        </button>
      </div>

      {totalAgencies === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No agencies registered
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          {/* Root Agencies Section */}
          {rootGroup && rootGroup.children.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 border-b border-gray-200 dark:border-gray-700 pb-2">
                Root Agencies
              </h2>
              <div className="space-y-3">
                {rootGroup.children.map((agency) => {
                  const childrenGroup = groups.get(agency.agency_id);
                  const childCount = childrenGroup?.children.length ?? 0;
                  const isExpanded = expandedParents.has(agency.agency_id);

                  return (
                    <div key={agency.agency_id} className="border border-gray-200 dark:border-gray-700 rounded p-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            {childCount > 0 && (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(agency.agency_id)}
                                className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                              >
                                {isExpanded ? "▼" : "▶"}
                              </button>
                            )}
                            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                              {agency.display_name}
                            </h3>
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                              {agency.agency_id}
                            </span>
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                            Provider: {agency.provider} | Host: {agency.host_id}
                          </div>
                          {childCount > 0 && (
                            <div className="text-xs text-green-600 dark:text-green-400 mt-1 ml-6">
                              ↳ {childCount} child{childCount !== 1 ? "ren" : ""}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Children List */}
                      {isExpanded && childCount > 0 && (
                        <div className="mt-3 ml-6 space-y-2 border-l-2 border-gray-300 dark:border-gray-600 pl-3">
                          {childrenGroup?.children.map((child) => (
                            <div
                              key={child.agency_id}
                              className="bg-gray-50 dark:bg-gray-700/50 p-2 rounded text-sm"
                            >
                              <div className="font-medium text-gray-900 dark:text-gray-100">
                                {child.display_name}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">
                                {child.agency_id}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                Provider: {child.provider} | Host: {child.host_id}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Nested Agencies Section */}
          {groups.size > 1 && (
            <div className="space-y-4 mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Nested Agencies
              </h2>
              <div className="space-y-3">
                {Array.from(groups.entries())
                  .filter(([parentId]) => parentId !== null)
                  .map(([_parentId, group]) => {
                    if (!group.parent) return null;
                    const isExpanded = expandedParents.has(group.parent.agency_id);
                    const childCount = group.children.length;

                    return (
                      <div key={group.parent.agency_id} className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-blue-50 dark:bg-blue-900/20">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              {childCount > 0 && (
                                <button
                                  type="button"
                                  onClick={() => toggleExpanded(group.parent!.agency_id)}
                                  className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                                >
                                  {isExpanded ? "▼" : "▶"}
                                </button>
                              )}
                              <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                                {group.parent.display_name}
                              </h3>
                              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                {group.parent.agency_id}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                              Parent:{" "}
                              <span className="font-mono text-yellow-600 dark:text-yellow-400">
                                {group.parent.parent_agency_id ?? "ROOT"}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                              Provider: {group.parent.provider} | Host:{" "}
                              {group.parent.host_id}
                            </div>
                            {childCount > 0 && (
                              <div className="text-xs text-green-600 dark:text-green-400 mt-1 ml-6">
                                ↳ {childCount} child{childCount !== 1 ? "ren" : ""}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Children List */}
                        {isExpanded && childCount > 0 && (
                          <div className="mt-3 ml-6 space-y-2 border-l-2 border-gray-300 dark:border-gray-600 pl-3">
                            {group.children.map((child) => (
                              <div
                                key={child.agency_id}
                                className="bg-gray-50 dark:bg-gray-700/50 p-2 rounded text-sm"
                              >
                                <div className="font-medium text-gray-900 dark:text-gray-100">
                                  {child.display_name}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">
                                  {child.agency_id}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                  Provider: {child.provider} | Host:{" "}
                                  {child.host_id}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CockpitAgencyRoster;
