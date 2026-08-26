import React from 'react';

const COLORS = {
  cyan:   'text-cyanx',
  red:    'text-redx',
  green:  'text-greenx',
  blue:   'text-blue-400',
  purple: 'text-purplex',
  orange: 'text-orangex',
  pink:   'text-pinkx',
  white:  'text-white',
};

export default function StatTile({ label, value, color = 'cyan', active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`card-tile flex-1 ${active ? 'active' : ''}`}>
      <div className="tile-label">{label}</div>
      <div className={`tile-value ${COLORS[color] || COLORS.cyan}`}>{value}</div>
    </button>
  );
}
