import { useCallback, useEffect, useRef, useState } from "react";
import { getServiceJobs, updateServiceJobStatus } from "../services/api";
import { sortJobs } from "../tiers/jobs";

const POLL_MS = 15000;

// The ArrivoAir, ArrivoBoat and ArrivoRemovals jobs assigned to this driver.
export function useServiceJobs(token, enabled = true) {
  const [jobs, setJobs] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const { jobs: list } = await getServiceJobs(token);
      if (mounted.current) setJobs(sortJobs(list || []));
    } catch (e) {
      // Non-fatal: try again on the next tick.
    }
  }, [token]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, load]);

  const advance = useCallback(async (job, to) => {
    setBusyId(job.id);
    setError(null);
    try {
      await updateServiceJobStatus(token, job.id, to);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setBusyId(null);
      load();
    }
  }, [token, load]);

  return { jobs, busyId, error, advance, reload: load };
}
