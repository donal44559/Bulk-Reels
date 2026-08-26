import React, { useEffect, useState } from 'react';
import api from '../api.js';
import StatTile from '../components/StatTile.jsx';

export default function Dashboard({ onFilterNavigate }) {
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [activeFilter, setActiveFilter] = useState('all');

  const refresh = async () => {
    setStats(await api.getStats());
    setHistory(await api.importHistory());
  };
  useEffect(() => { refresh(); }, []);

  // Live update when tasks finish updating profile statuses
  useEffect(() => {
    const off = api.onTaskUpdate?.(() => {
      if (Date.now() - (refresh._last || 0) < 1000) return;
      refresh._last = Date.now();
      refresh();
    });
    return () => { off && off(); };
  }, []);

  const jumpTo = (filter) => {
    setActiveFilter(filter);
    onFilterNavigate && onFilterNavigate(filter);
  };

  const ps = stats?.profile_status || {};
  const pg = stats?.page_status || {};
  const groups = stats?.groups || [];

  return (
    <div className="space-y-5">
      <Section title="PROFILE STATUS">
        <div className="flex gap-4">
          <StatTile label="ALL PROFILES"    value={ps.all_profiles ?? 0}    color="cyan"   active={activeFilter==='all'}          onClick={() => jumpTo('all')} />
          <StatTile label="RESTRICTED"      value={ps.restricted ?? 0}      color="red"    active={activeFilter==='restricted'}   onClick={() => jumpTo('restricted')} />
          <StatTile label="NO RESTRICTIONS" value={ps.no_restrictions ?? 0} color="green"  active={activeFilter==='no_restrict'}  onClick={() => jumpTo('no_restrict')} />
          <StatTile label="LOGIN FAILED!"   value={ps.login_failed ?? 0}    color="orange" active={activeFilter==='login_failed'} onClick={() => jumpTo('login_failed')} />
          <StatTile label="UNKNOWN"         value={ps.unknown ?? 0}         color="blue"   active={activeFilter==='unknown'}      onClick={() => jumpTo('unknown')} />
        </div>
        {/* Detailed breakdown from real Facebook Profile Status page (Recommendations) */}
        <div className="mt-3 grid grid-cols-4 gap-4">
          <StatTile label="ACTIVE"     value={ps.active ?? 0}    color="green"  active={activeFilter==='active'}    onClick={() => jumpTo('active')} />
          <StatTile label="LIMITED"    value={ps.limited ?? 0}   color="pink"   active={activeFilter==='limited'}   onClick={() => jumpTo('limited')} />
          <StatTile label="AT RISK"    value={ps.at_risk ?? 0}   color="orange" active={activeFilter==='at_risk'}   onClick={() => jumpTo('at_risk')} />
          <StatTile label="SUSPENDED"  value={ps.suspended ?? 0} color="red"    active={activeFilter==='suspended'} onClick={() => jumpTo('suspended')} />
        </div>
      </Section>

      <Section title="PAGE STATUS">
        <div className="flex gap-4">
          <StatTile label="ALL PAGE"             value={pg.all_pages ?? 0}        color="cyan"   />
          <StatTile label="PAGE HAS SOME ISSUES" value={pg.page_some_issues ?? 0} color="orange" />
          <StatTile label="PAGE HAS NO ISSUES"   value={pg.page_no_issues ?? 0}   color="green"  />
          <StatTile label="NO PAGE CREATE"       value={pg.no_page_create ?? 0}   color="red"    />
          <StatTile label="CHECKPOINT"           value={pg.checkpoint ?? 0}       color="orange" />
        </div>
      </Section>

      <Section title="GROUP NAME">
        {groups.length === 0 ? (
          <div className="text-muted text-sm">No groups yet.</div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {groups.map(g => {
              const key = 'group:' + g.group_name;
              return (
                <StatTile
                  key={g.group_name}
                  label={g.group_name}
                  value={g.c}
                  color="purple"
                  active={activeFilter === key}
                  onClick={() => jumpTo(key)}
                />
              );
            })}
          </div>
        )}
      </Section>

      <Section title="IMPORT HISTORY">
        {history.length === 0 ? (
          <div className="text-muted text-sm">No imports yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-muted">
              <tr><th className="p-2 text-left">Import Date/Time</th><th className="p-2 text-left">Profiles Imported</th><th className="p-2 text-right">Source</th></tr>
            </thead>
            <tbody>
              {history.slice(0, 8).map(h => (
                <tr key={h.id} className="table-row">
                  <td className="p-2 text-greenx">{h.imported_at}</td>
                  <td className="p-2 text-cyanx font-semibold">{h.profiles_imported}</td>
                  <td className="p-2 text-right text-muted">{h.source_file || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="panel p-5">
      <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-4">{title}</div>
      {children}
    </div>
  );
}
