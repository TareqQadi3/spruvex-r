export interface StepProps {
  /** Real data was saved — marks the step "done" and returns to the hub. */
  onDone: () => void | Promise<void>;
  /** Owner explicitly deferred this step — marks it "skipped" and returns to the hub. */
  onSkip: () => void | Promise<void>;
}
