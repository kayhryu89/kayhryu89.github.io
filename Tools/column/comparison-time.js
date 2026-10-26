/* Shared time grid for 1D FVM-BE versus 1D OCFE-BE.
   Both use first-order Lie splitting: implicit BE gas transport, then
   implicit BE local LDF adsorption, on exactly the same time substeps. */
export function comparisonTimeGrid(config){
 const {simulation:s}=config;
 const outputIntervals=s.snapshots*Math.max(8,Math.ceil(64/s.snapshots));
 const stepsPerOutput=s.beStepsPerOutput??16;
 if(!Number.isInteger(stepsPerOutput)||stepsPerOutput<1||stepsPerOutput>128)
  throw Error("BE comparison steps per output must be an integer between 1 and 128.");
 const totalSteps=outputIntervals*stepsPerOutput;
 if(totalSteps>s.maxSteps)throw Error("BE comparison step count exceeds solver step limit.");
 const dt=s.endTime/totalSteps;
 return {outputIntervals,stepsPerOutput,totalSteps,dt,description:"BE transport → BE implicit LDF, first-order Lie split"};
}
