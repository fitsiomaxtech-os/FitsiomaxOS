/**
 * The medical and physiotherapy knowledge base the spell check retrieves from
 * (lib/spellcheck). Four parts:
 *  - TERMS: words a patient writes about their body, condition, treatment and medicines.
 *    They are never marked wrong, and a misspelt word looks here first for its fix.
 *  - CANON: the same, where the spelling has a fixed case (MRI, X-ray, Parkinson's).
 *  - MISSPELT: common wrong spellings with their one right answer, ahead of any guess.
 *  - CONTEXT: real English words that are wrong in a medical answer ("lumber pain").
 * Plain English comes from public/spell/en-words.txt; this file is only what that lacks
 * or ranks too low.
 */

const words = (text) => text.split(/\s+/).filter(Boolean);

export const TERMS = words(`
  pain pains painful ache aches aching sore soreness knee knees back backache neck hip hips ankle
  ankles wrist wrists elbow elbows shoulder shoulders foot feet heel heels toe toes finger fingers
  thumb hand hands leg legs arm arms thigh thighs groin chest head waist buttock buttocks lt rt
  sitting standing walking climbing stairs bending lifting sleeping running jogging cycling
  anatomy body bone bones joint joints muscle muscles tendon tendons ligament ligaments cartilage
  nerve nerves spine spinal skull cranium mandible maxilla jaw clavicle collarbone scapula scapulae
  sternum rib ribs humerus radius ulna carpal carpals metacarpal metacarpals phalanx phalanges
  pelvis pelvic ilium iliac ischium ischial pubis pubic sacrum sacral coccyx coccygeal femur femoral
  patella patellar kneecap tibia tibial fibula fibular tarsal tarsals metatarsal metatarsals
  calcaneus calcaneal talus talar navicular cuboid cuneiform vertebra vertebrae vertebral atlas axis
  olecranon acromion acromial glenoid trochanter trochanteric malleolus malleoli sesamoid hyoid
  scaphoid lunate triquetrum pisiform trapezium trapezoid capitate hamate acetabulum acetabular
  epicondyle epicondyles condyle condyles tuberosity tubercle process spinous transverse lamina
  cervical thoracic lumbar lumbosacral cervicothoracic thoracolumbar sacroiliac intervertebral
  disc discs disk disks facet facets nucleus pulposus annulus fibrosus foramen foramina foraminal
  stenosis radiculopathy myelopathy spondylosis spondylitis spondylolisthesis spondylolysis
  scoliosis kyphosis lordosis sciatica sciatic prolapse prolapsed herniation herniated bulge
  bulging protrusion extrusion sequestration degenerative degeneration discectomy laminectomy
  microdiscectomy fusion coccydynia osteophyte osteophytes
  trapezius rhomboid rhomboids levator latissimus dorsi deltoid deltoids supraspinatus infraspinatus
  teres subscapularis pectoralis pectoral serratus biceps bicep triceps tricep brachialis
  brachioradialis pronator supinator flexor flexors extensor extensors carpi digitorum pollicis
  abductor abductors adductor adductors iliopsoas psoas iliacus gluteus gluteal glutes maximus
  medius minimus piriformis tensor fasciae latae sartorius quadriceps quadricep quads rectus
  femoris vastus lateralis medialis intermedius hamstring hamstrings semitendinosus
  semimembranosus gracilis pectineus gastrocnemius gastroc soleus tibialis peroneus peroneal
  peronei fibularis plantaris popliteus sternocleidomastoid scalene scalenes splenius capitis
  cervicis suboccipital suboccipitals multifidus erector spinae quadratus lumborum transversus
  abdominis oblique obliques diaphragm intercostal intercostals masseter temporalis pterygoid
  lats delts traps pecs abs calf calves core rotator cuff
  meniscus menisci meniscal labrum labral bursa bursae capsule capsular synovial synovium fascia
  fascial plantar palmar achilles cruciate collateral iliotibial acromioclavicular
  sternoclavicular glenohumeral temporomandibular patellofemoral tibiofemoral subacromial
  arthritis osteoarthritis rheumatoid gout gouty tendinitis tendonitis tendinopathy tendinosis
  bursitis fasciitis fasciopathy epicondylitis epicondylalgia tenosynovitis capsulitis synovitis
  adhesive impingement sprain sprained strain strained fracture fractured fractures dislocation
  dislocated subluxation contusion spasm spasms cramp cramps stiffness numbness tingling
  paraesthesia paresthesia neuropathy neuralgia radiating vertigo migraine headache headaches
  cervicogenic whiplash torticollis osteoporosis osteopenia osteomyelitis fibromyalgia myalgia
  arthralgia chondromalacia ankylosing metatarsalgia bunion bunions hallux valgus varus genu
  flatfoot planus cavus hemiplegia paraplegia quadriplegia tetraplegia hemiparesis paraparesis
  stroke paralysis paralysed paralyzed palsy cerebral parkinsonism dystrophy sclerosis
  myasthenia myopathy myositis diabetic diabetes mellitus hypertension hypotension hypertensive
  hypothyroidism hyperthyroidism thyroid cholesterol asthma asthmatic bronchitis tuberculosis
  anaemia anemia obesity menopause pregnancy pregnant postpartum postnatal antenatal prenatal
  caesarean cesarean hysterectomy incontinence diastasis recti ganglion cyst cysts oedema edema
  swelling swollen inflammation inflammatory inflamed infection infected injury injuries injured
  trauma traumatic postoperative preoperative operative rehabilitation rehab reconstruction
  arthroscopy arthroscopic arthroplasty replacement osteotomy plating nailing implant implants
  cast plaster splint splints brace braces collar orthosis orthotic orthotics insole insoles
  crutches crutch walker wheelchair bedridden bedsore bedsores ulcer ulcers varicose
  veins vein haemorrhoids hemorrhoids piles hernia appendix appendicitis kidney kidneys renal
  liver gallbladder gallstones stones calculi cardiac heart angina angioplasty stent stents bypass
  pacemaker arrhythmia palpitations breathlessness wheezing cough fever chills fatigue tiredness
  weakness dizziness giddiness nausea vomiting constipation acidity gastritis reflux indigestion
  insomnia anxiety depression stress tremor tremors seizure seizures epilepsy dementia
  alzheimer neuro neurological neurologist neurology neurosurgeon neurosurgery ortho orthopaedic
  orthopedic orthopaedics orthopedics orthopaedician orthopedician orthopaedist orthopedist
  rheumatologist rheumatology physician gynaecologist gynecologist cardiologist diabetologist
  endocrinologist pulmonologist urologist nephrologist oncologist paediatric pediatric
  paediatrician pediatrician geriatric radiologist surgeon surgery surgeries surgical operation
  operated consultation consultations consulted consultant specialist chiropractor chiropractic
  osteopath osteopathy ayurveda ayurvedic homeopathy homoeopathy homeopathic homoeopathic siddha
  unani allopathy allopathic naturopathy panchakarma acupressure acupuncture varmam
  physiotherapy physiotherapist physiotherapists physio physios therapist therapy therapies
  exercise exercises stretching stretches strengthening mobilisation mobilization manipulation
  traction interferential ultrasound shortwave diathermy laser cryotherapy thermotherapy
  hydrotherapy paraffin electrotherapy taping kinesio kinesiology needling cupping myofascial
  isometric isometrics isotonic isokinetic eccentric concentric proprioceptive proprioception
  neuromuscular facilitation gait posture postural ergonomic ergonomics balance coordination
  pilates yoga massage massaged mobility flexibility endurance
  flexion extension hyperextension abduction adduction rotation pronation supination inversion
  eversion dorsiflexion plantarflexion protraction retraction elevation depression deviation
  anterior posterior lateral medial proximal distal superior inferior dorsal ventral bilateral
  unilateral ipsilateral contralateral acute subacute chronic recurrent intermittent radiating
  diagnosis diagnosed diagnoses prognosis symptom symptoms symptomatic asymptomatic investigation
  investigations report reports scan scans ultrasonography sonography ecg echo electromyography
  haemoglobin hemoglobin platelet platelets creatinine urea uric vitamin vitamins calcium
  potassium sodium magnesium zinc iron ferritin glucose fasting
  medicine medicines medication medications tablet tablets capsule capsules syrup ointment
  cream gel spray injection injections dose doses dosage prescription prescribed painkiller
  painkillers analgesic analgesics antibiotic antibiotics steroid steroids supplement supplements
  paracetamol acetaminophen ibuprofen diclofenac aceclofenac naproxen etoricoxib celecoxib
  nimesulide piroxicam ketorolac indomethacin mefenamic tramadol tapentadol pregabalin gabapentin
  duloxetine amitriptyline nortriptyline methylcobalamin mecobalamin thiocolchicoside
  chlorzoxazone tizanidine eperisone baclofen methocarbamol cyclobenzaprine prednisolone
  methylprednisolone dexamethasone deflazacort hydrocortisone omeprazole pantoprazole rabeprazole
  esomeprazole ranitidine famotidine domperidone ondansetron metformin glimepiride gliclazide
  sitagliptin vildagliptin teneligliptin dapagliflozin empagliflozin insulin amlodipine
  telmisartan losartan olmesartan atenolol metoprolol bisoprolol ramipril enalapril
  hydrochlorothiazide chlorthalidone furosemide spironolactone atorvastatin rosuvastatin aspirin
  clopidogrel warfarin levothyroxine thyroxine cholecalciferol calcitriol alendronate risedronate
  ibandronate zoledronic teriparatide glucosamine chondroitin diacerein collagen hyaluronic
  methotrexate hydroxychloroquine sulfasalazine leflunomide colchicine febuxostat allopurinol
  cetirizine levocetirizine montelukast salbutamol budesonide azithromycin amoxicillin
  clavulanate cefixime ciprofloxacin levofloxacin doxycycline metronidazole multivitamin folic
  ferrous omega serratiopeptidase trypsin chymotrypsin bromelain
  dolo crocin calpol combiflam brufen voveran zerodol hifenac nise aceclo ultracet myospaz myoril
  thiospas neurobion nurokind pregaba shelcal calcirol uprise tayo thyronorm eltroxin glycomet
  janumet galvus amlong telma ecosprin pantocid pantop razo rantac omez volini moov iodex
  relispray ostocalcium cartigen jointace dynapar flexon sumo saridon disprin
  mg mcg ml kg cm mm hr hrs min mins yr yrs wk wks mth mths approx
  od bd tds qid hs sos prn
`);

// Spelled with a set case; matched without it, suggested with it.
export const CANON = words(`
  MRI CT X-ray ECG EEG EMG NCV NCS CBC ESR CRP HbA1c USG BMD BMI BP DM HTN COPD TB CVA TIA PCOD PCOS
  ACL PCL MCL LCL ITB TMJ SI IVDP PIVD LBP OA RA AS ROM AROM PROM IFT TENS UST SWD EMS NMES LLLT
  PNF MET MFR DOMS RICE TKR THR TKA THA ORIF ICU OPD IP OP GP NSAID NSAIDs
  Parkinson's Alzheimer's Bell's Achilles Mulligan Maitland McKenzie Bobath Guillain-Barré
  De Quervain's Dupuytren's Osgood-Schlatter
`);

// A wrong spelling and its fix, taken before anything is guessed.
export const MISSPELT = {
  sholder: "shoulder", sholders: "shoulders", shoulde: "shoulder", sholdar: "shoulder", shouder: "shoulder",
  artheritis: "arthritis", arthiritis: "arthritis", athritis: "arthritis", arthrities: "arthritis", arthritus: "arthritis",
  osteoarthiritis: "osteoarthritis", osteoartheritis: "osteoarthritis",
  physiotheraphy: "physiotherapy", physiotherphy: "physiotherapy", phisiotherapy: "physiotherapy",
  physiotherepy: "physiotherapy", fisiotherapy: "physiotherapy", physiotheraphist: "physiotherapist",
  theraphy: "therapy", therapi: "therapy",
  spondilosis: "spondylosis", spondylosys: "spondylosis", spondolysis: "spondylosis", spondilitis: "spondylitis",
  spondilolisthesis: "spondylolisthesis",
  sciatika: "sciatica", siatica: "sciatica", sciatia: "sciatica",
  ligment: "ligament", ligement: "ligament", legament: "ligament", ligamant: "ligament",
  muscel: "muscle", mucsle: "muscle", musle: "muscle", muscels: "muscles", mussle: "muscle", mussles: "muscles",
  tendan: "tendon", tendom: "tendon", cartilege: "cartilage", cartlage: "cartilage",
  menicus: "meniscus", miniscus: "meniscus", meniscous: "meniscus",
  fracher: "fracture", fractur: "fracture", facture: "fracture", fracure: "fracture", disloction: "dislocation",
  surgary: "surgery", sergery: "surgery", surjery: "surgery", sugery: "surgery", opration: "operation", operaton: "operation",
  injuction: "injection", injecton: "injection", tablate: "tablet", tabelet: "tablet", tablates: "tablets",
  asthama: "asthma", astma: "asthma", diabetis: "diabetes", diabities: "diabetes", daibetes: "diabetes",
  sugur: "sugar", suger: "sugar", presure: "pressure", pressur: "pressure",
  cholestrol: "cholesterol", colestrol: "cholesterol", thyriod: "thyroid", thyroide: "thyroid",
  hypertention: "hypertension", migrane: "migraine", migrain: "migraine",
  inflamation: "inflammation", sweling: "swelling", numbess: "numbness", numbnes: "numbness",
  tingeling: "tingling", stifness: "stiffness", stiffnes: "stiffness",
  paracetmol: "paracetamol", parasitamol: "paracetamol", paracetemol: "paracetamol", ibuprofin: "ibuprofen",
  diclofenic: "diclofenac", xray: "X-ray", xrays: "X-rays",
  ankel: "ankle", ancle: "ankle", angkle: "ankle", kneee: "knee", knea: "knee", rist: "wrist", elbo: "elbow",
  servical: "cervical", lumbur: "lumbar", lumbr: "lumbar", verterbra: "vertebra", vertibra: "vertebra", vertebrea: "vertebrae",
  quadraceps: "quadriceps", hamstrig: "hamstring", faciitis: "fasciitis", fascitis: "fasciitis",
  fasciatis: "fasciitis", facitis: "fasciitis", bursitus: "bursitis", tunnle: "tunnel",
  osteoporosys: "osteoporosis", osteoperosis: "osteoporosis", rheumatiod: "rheumatoid",
  rhematoid: "rheumatoid", rumatoid: "rheumatoid", paralisis: "paralysis", paralysys: "paralysis",
  strock: "stroke", hemiplagia: "hemiplegia", parkinsons: "Parkinson's", alzheimers: "Alzheimer's",
  excercise: "exercise", exercice: "exercise", excersise: "exercise", exersice: "exercise", excercises: "exercises",
  streching: "stretching", strenghtening: "strengthening", strengthning: "strengthening", strenthening: "strengthening",
  posure: "posture", postur: "posture", masage: "massage", massge: "massage", acupunture: "acupuncture",
  chiropracter: "chiropractor", docter: "doctor", doctar: "doctor", hospitel: "hospital",
  medecine: "medicine", medicin: "medicine", medicene: "medicine", medicaton: "medication", prescripton: "prescription",
  consultaion: "consultation", consulation: "consultation", diagnosys: "diagnosis", diagonosis: "diagnosis",
  diagonised: "diagnosed", diagnosised: "diagnosed", sevear: "severe", painfull: "painful", unbearble: "unbearable",
  accidant: "accident", injurey: "injury", injery: "injury", sprane: "sprain", spasam: "spasm", spasem: "spasm",
  weekness: "weakness", dizzyness: "dizziness", nausia: "nausea", vomitting: "vomiting", feaver: "fever", fevar: "fever",
  monthes: "months", yeras: "years", befor: "before", becuase: "because", beacuse: "because", becasue: "because",
  vericose: "varicose", untill: "until", alot: "a lot", recieved: "received", recieve: "receive", definately: "definitely",
  wierd: "weird", thier: "their", teh: "the", adn: "and", morining: "morning", mornig: "morning", nite: "night",
  dont: "don't", doesnt: "doesn't", didnt: "didn't", isnt: "isn't", wasnt: "wasn't", arent: "aren't",
  werent: "weren't", havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", couldnt: "couldn't",
  shouldnt: "shouldn't", wouldnt: "wouldn't", im: "I'm", ive: "I've", cant: "can't", wont: "won't", thats: "that's",
};

// Real words a medical answer almost never means. `always` swaps wherever the word is; the
// rest only beside one of the `next` words that follow, or after one of the `prev` words.
const BODY_NEXT = ["pain", "pains", "joint", "joints", "sprain", "swelling", "injury", "fracture", "ligament", "region", "area", "stiffness", "twist"];
export const CONTEXT = {
  lumber: { fix: "lumbar", always: true },
  planter: { fix: "plantar", always: true },
  carpel: { fix: "carpal", always: true },
  mussel: { fix: "muscle", always: true },
  mussels: { fix: "muscles", always: true },
  heal: { fix: "heel", next: ["pain", "pains", "spur", "spurs", "bone", "region", "area", "swelling", "cushion"] },
  angle: { fix: "ankle", next: BODY_NEXT },
  wrest: { fix: "wrist", next: BODY_NEXT, prev: ["left", "right", "both", "my"] },
  waste: { fix: "waist", next: ["pain", "region", "area", "line"] },
  sever: { fix: "severe", next: ["pain", "pains", "headache", "ache", "swelling", "cramps", "stiffness", "weakness", "injury", "spasm"] },
  calve: { fix: "calf", next: ["pain", "muscle", "muscles", "cramp", "cramps"] },
  chord: { fix: "cord", prev: ["spinal", "vocal", "umbilical"] },
  vains: { fix: "veins", prev: ["varicose"] },
  vain: { fix: "vein", prev: ["varicose"] },
};

// Short forms that end a word with a full stop, not a sentence.
export const ABBREVIATIONS = new Set(["e.g", "eg", "i.e", "ie", "etc", "dr", "mr", "mrs", "ms", "vs", "approx", "no", "st", "sr", "jr", "dept", "hosp"]);
