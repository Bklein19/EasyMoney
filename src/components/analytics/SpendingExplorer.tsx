import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ChevronRight, List, Search } from 'lucide-react';
import type { SpendingNode } from '../../../server/app/spendingExplorer';
import { CHART_SERIES_COLORS } from '../../styles/chartColors';
import { formatCurrency } from '../../utils/formatters';
import { resolveSpendingPath, spendingArc, spendingFamilyIndex, spendingSegments } from './spendingExplorerLayout';
import './SpendingExplorer.css';

interface Props {
  root?: SpendingNode;
  renderTransactions: (node: SpendingNode) => ReactNode;
  saving?: boolean;
}

const percent = (amount: number, total: number) => new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(total ? amount / total : 0);
const money = (node: SpendingNode) => formatCurrency(node.amountCents / 100);

export default function SpendingExplorer({ root, renderTransactions, saving = false }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [transactionNode, setTransactionNode] = useState<SpendingNode | null>(null);
  const transactionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (transactionNode) transactionHeading.current?.focus({ preventScroll: true });
  }, [transactionNode]);
  const path = useMemo(() => root ? resolveSpendingPath(root, selectedIds) : [], [root, selectedIds]);
  const selected = path[path.length - 1];
  const parent = path[path.length - 2];
  const familyId = path[1]?.id ?? root?.id ?? 'spending';
  const segments = useMemo(() => selected ? spendingSegments(selected, familyId) : [], [selected, familyId]);
  const ringCount = segments.reduce((count, segment) => Math.max(count, segment.depth + 1), 1);
  const ringWidth = (222 - 96) / ringCount;
  const hovered = segments.find(segment => segment.node.id === hoverId)?.node;
  const center = hovered ?? selected;

  if (!root || !selected || !center || (!root.amountCents && !transactionNode)) return <div className="empty-state">
    <p className="empty-state__description">No spending in this period. Choose another date range or account.</p>
  </div>;

  const colorFor = (id: string) => CHART_SERIES_COLORS[spendingFamilyIndex(id)]!;
  const visibleChildren = selected.children.filter(node => node.name.toLowerCase().includes(search.trim().toLowerCase()));
  function navigate(node: SpendingNode) {
    if (saving) return;
    if (!node.children.length) {
      setTransactionNode(node);
      setHoverId(null);
      return;
    }
    // Clicking an outer ring may skip directly to a subcategory or merchant.
    function findPath(parent: SpendingNode, target: string): string[] | null {
      for (const child of parent.children) {
        if (child.id === target) return [child.id];
        const nested = findPath(child, target);
        if (nested) return [child.id, ...nested];
      }
      return null;
    }
    setSelectedIds([...path.slice(1).map(entry => entry.id), ...(findPath(selected!, node.id) ?? [])]);
    setHoverId(null);
    setSearch('');
    setTransactionNode(null);
  }
  function goTo(index: number) {
    if (saving) return;
    setSelectedIds(path.slice(1, index + 1).map(node => node.id));
    setHoverId(null);
    setSearch('');
    setTransactionNode(null);
  }

  return <section className="spending-explorer" aria-label="Spending explorer">
    <nav className="spending-explorer__breadcrumbs" aria-label="Spending path">
      {path.map((node, index) => <span key={node.id}>
        {index > 0 && <ChevronRight size={13} aria-hidden="true" />}
        <button type="button" disabled={saving} onClick={() => goTo(index)} aria-current={index === path.length - 1 ? 'location' : undefined}>{node.name}</button>
      </span>)}
    </nav>
    <div className="spending-explorer__body">
      <div className="spending-explorer__visual">
        <svg viewBox="0 0 480 480" aria-label="Nested spending rings. Inner rings are categories; outer rings show their breakdown.">
          {segments.map(segment => <path
            key={segment.node.id}
            d={spendingArc(segment.start, segment.end, 96 + segment.depth * ringWidth, 96 + (segment.depth + 1) * ringWidth - 4)}
            fill={colorFor(segment.familyId)}
            fillOpacity={hoverId && hoverId !== segment.node.id && !hoverId.startsWith(`${segment.node.id}/`) && !segment.node.id.startsWith(`${hoverId}/`) ? 0.32 : 1 - segment.depth * 0.15}
            role="button"
            tabIndex={saving ? -1 : 0}
            aria-disabled={saving}
            aria-label={`${segment.node.name}: ${money(segment.node)}, ${percent(segment.node.amountCents, selected.amountCents)} of ${selected.name}. ${segment.node.children.length ? 'Explore' : 'View transactions'}`}
            onClick={() => navigate(segment.node)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(segment.node); } }}
            onMouseEnter={() => setHoverId(segment.node.id)}
            onMouseLeave={() => setHoverId(null)}
            onFocus={() => setHoverId(segment.node.id)}
            onBlur={() => setHoverId(null)}
          ><title>{`${segment.node.name} · ${money(segment.node)}`}</title></path>)}
        </svg>
        <div className="spending-explorer__center">
          <button type="button" className="spending-explorer__center-control"
            disabled={!parent || saving} aria-label={parent ? `Go up to ${parent.name}` : 'All spending. Top level'}
            title={parent ? `Go up to ${parent.name}` : 'All spending. Top level'}
            onClick={() => goTo(path.length - 2)} onMouseEnter={() => setHoverId(null)} onFocus={() => setHoverId(null)}>
            <span>{center.name}</span>
            <strong className={money(center).length > 12 ? 'spending-explorer__large-amount' : undefined}>{money(center)}</strong>
            <small>{center.transactionIds.length.toLocaleString()} transaction{center.transactionIds.length === 1 ? '' : 's'}</small>
            <small>{center.id === root.id ? 'Selected period' : `${percent(center.amountCents, root.amountCents)} of all spending`}</small>
          </button>
        </div>
        <p className="spending-explorer__hint">Click a ring to explore.{parent && ' Click the center to go up one level.'} Small segments are also in the list.</p>
      </div>
      <div className="spending-explorer__breakdown">
        {transactionNode ? <div className="spending-explorer__transaction-panel">
          <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={() => setTransactionNode(null)}><ArrowLeft size={14} />Back to breakdown</button>
          <h4 ref={transactionHeading} tabIndex={-1}>{transactionNode.name}</h4>
          {renderTransactions(transactionNode)}
        </div> : <>
        <div className="spending-explorer__summary">
          <div><h4>{selected.name}</h4><span>{selected.transactionIds.length.toLocaleString()} transactions · {percent(selected.amountCents, root.amountCents)} of spending</span></div>
          <strong>{money(selected)}</strong>
        </div>
        <div className="spending-explorer__tools">
          {path.length > 1 && <button type="button" className="btn btn--ghost btn--sm" onClick={() => goTo(path.length - 2)}><ArrowLeft size={14} />Back</button>}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTransactionNode(selected)}><List size={14} />View & categorize</button>
        </div>
        <label className="spending-explorer__search"><Search size={15} aria-hidden="true" /><input aria-label="Search this spending breakdown" placeholder="Find in this breakdown…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="spending-explorer__rows" role="list" aria-label={`${selected.name} breakdown`}>
          {visibleChildren.map(node => <div role="listitem" key={node.id}>
            <button type="button" className={`spending-explorer__row ${hoverId === node.id ? 'is-hovered' : ''}`} onClick={() => navigate(node)} onMouseEnter={() => setHoverId(node.id)} onMouseLeave={() => setHoverId(null)} onFocus={() => setHoverId(node.id)} onBlur={() => setHoverId(null)}>
              <span className="spending-explorer__swatch" style={{ background: colorFor(selected.kind === 'root' ? node.id : familyId) }} aria-hidden="true" />
              <span className="spending-explorer__name"><span>{node.name}</span><small>{node.kind === 'merchant' ? 'Merchant' : node.kind === 'merchant-group' ? 'Merchant group' : 'Category'} · {node.transactionIds.length.toLocaleString()} transaction{node.transactionIds.length === 1 ? '' : 's'}</small></span>
              <span className="spending-explorer__amount"><strong>{money(node)}</strong><small>{percent(node.amountCents, selected.amountCents)}</small></span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>)}
          {!visibleChildren.length && <p className="spending-explorer__no-results">No matching categories or merchants here.</p>}
        </div>
        </>}
      </div>
    </div>
    <p className="spending-explorer__note">Gross spending before refunds, using current classifications. Activity classified as transfers, card payments, or investment movements is excluded. Uncategorized remains visible.</p>
  </section>;
}
