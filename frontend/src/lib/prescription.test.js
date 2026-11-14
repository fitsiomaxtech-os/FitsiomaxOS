import { prescriptionData, prescriptionMissing, wrapPrescriptionText } from "./prescription";

const lead = {
  name: "Test Patient", patient_number: "ANN-001", age: 0,
  appointment_date: "2026-11-13", assigned_physio_name: "Dr. Test Consultant",
  diagnosis: "Pre-sales note must not enter prescription",
  physio_diagnosis_report: "Consultant diagnosis", treatment_summary: "Exercise therapy",
  consultation_decision: "consultation_treatment", session_package_name: "Two weeks",
  session_package_sessions: 10,
};

test("uses patient branch, booked consultation date and attending consultant", () => {
  const data = prescriptionData(lead, { address: "Patient branch address" });
  expect(data).toMatchObject({ address: "Patient branch address", date: "13/11/2026", consultant: "Dr. Test Consultant", age: "0" });
  expect(data.diagnosis).toBe("Consultant diagnosis");
  expect(data.plan).toContain("Two weeks — 10 sessions");
  expect(prescriptionMissing(data)).toBe("");
});

test("does not manufacture diagnosis, address, date or signer", () => {
  expect(prescriptionData({ diagnosis: "Pre-sales only" }, {}).diagnosis).toBe("");
  const data = prescriptionData(lead, { address: "Branch" });
  for (const field of ["diagnosis", "address", "date", "consultant"]) {
    expect(prescriptionMissing({ ...data, [field]: "" })).not.toBe("");
  }
});

test("allows consultation-only prescriptions with no treatment summary", () => {
  const data = prescriptionData({ ...lead, consultation_decision: "consultation_only", treatment_summary: "" }, { address: "Branch" });
  expect(data.plan).toBe("Consultation only");
  expect(prescriptionMissing(data)).toBe("");
});

test("includes consultant referrals and their selected packages", () => {
  const data = prescriptionData({ ...lead, diet_recommended: true, diet_chart: true,
    rehab_referred: true, rehab_package_name: "Rehab programme", rehab_package_sessions: 6,
    fitness_recommended: true, zumba_recommended: true, zumba_package_name: "Monthly", rehab_after_treatment: true }, {});
  expect(data.plan).toContain("Diet: Diet chart");
  expect(data.plan).toContain("Rehab: Rehab programme — 6 sessions");
  expect(data.plan).toContain("Fitness: Referred");
  expect(data.plan).toContain("Zumba: Monthly");
  expect(data.plan).toContain("Rehab after treatment: Consultant to select package");
});

test("wraps paragraphs and overlong words without dropping characters", () => {
  const ctx = { measureText: (text) => ({ width: Array.from(text).length }) };
  const text = "First paragraph\n\nABCDEFGHIJKLMNO\nதமிழ்";
  const lines = wrapPrescriptionText(ctx, text, 8);
  expect(lines.every((line) => Array.from(line).length <= 8)).toBe(true);
  expect(lines.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  expect(lines).toContain("");
});
