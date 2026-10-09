import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistantStatusBadge, WhatsAppChat } from '@/components/ai/visuals';
import { WizardStepper } from '@/components/ai/wizard-steps';

describe('AI assistant UI', () => {
  it('chat renders customer/assistant text inertly and labels demo vs live clearly', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { container } = render(<WhatsAppChat title="ABC Dental" label="Demo preview" messages={[
      { from: 'customer', text: evil }, { from: 'tool', tool: 'CHECK_AVAILABILITY', label: 'Checked availability' }, { from: 'assistant', text: '4 PM available hai' }]} />);
    expect(screen.getByText('Demo preview')).toBeTruthy();
    expect(screen.getByText(evil)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/Checked availability/)).toBeTruthy();
    expect(container.innerHTML).not.toContain('CHECK_AVAILABILITY'); // internal tool names stay out of customer-style previews
  });

  it('status badges use words, and the 8-step setup journey marks progress', () => {
    render(<><AssistantStatusBadge status="ACTIVE" /><AssistantStatusBadge status="PAUSED" /><WizardStepper current="Knowledge" /></>);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    const current = screen.getByText('Knowledge').closest('li')!;
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
  });
});
