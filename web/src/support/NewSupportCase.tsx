import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useSubmission } from '../auth/useSubmission';
import { Page } from '../components/Page';
import { useT } from '../i18n';
import { casePayload, categories, readCase, readOpenCase, supportError } from './model';
import type { OpenCase } from './model';
import { SupportSignIn } from './SupportHome';

export function NewSupportCase() {
  const t = useT().support;
  const { user } = useAuth();
  const [query] = useSearchParams();
  const open = readOpenCase(query);
  return <Page eyebrow={t.menu} title={t.create} description={t.createDescription}>
    {open === null ? <p className="notice notice-error" role="alert">{t.errors.CONTEXT_REQUIRED}</p>
      : !user ? <SupportSignIn />
      : open.kind === 'organizer' && user.role !== 'organizer' ? <p className="notice notice-error" role="alert">{t.errors.FORBIDDEN}</p>
      : <CaseForm key={`${user.id}:${query}`} open={open} />}
    <p><Link className="text-link" to="/support">{t.mine}</Link></p>
  </Page>;
}

function CaseForm({ open }: { open: OpenCase }) {
  const t = useT().support;
  const navigate = useNavigate();
  const { request } = useAuth();
  const submission = useSubmission();
  const [category, setCategory] = useState<string>(categories[open.kind][0]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  return <div className="content-card support-panel">
    {open.source && <p>{t.sourceHint}</p>}
    <form className="support-form" noValidate aria-busy={submission.pending}
      onSubmit={event => {
        event.preventDefault();
        void submission.submit(async signal => {
          const body = casePayload(open, category, subject, message);
          const created = readCase(await request('/support/cases', { method: 'POST', body, signal }));
          if (!signal.aborted) navigate(`/support/cases/${created.id}`);
        });
      }}>
      <label>{t.category}
        <select value={category} onChange={event => setCategory(event.currentTarget.value)}>
          {categories[open.kind].map(value => <option key={value} value={value}>{t.categories[value]}</option>)}
        </select>
      </label>
      <label>{t.subject}<input required value={subject} onChange={event => setSubject(event.currentTarget.value)} /></label>
      <label>{t.message}<textarea required rows={5} value={message} onChange={event => setMessage(event.currentTarget.value)} /></label>
      {submission.error !== null && <p role="alert" className="notice notice-error">{supportError(submission.error, t)}</p>}
      <button className="button" type="submit" disabled={submission.pending}>{t.send}</button>
    </form>
  </div>;
}
