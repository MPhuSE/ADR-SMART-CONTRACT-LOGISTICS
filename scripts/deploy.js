const hre = require("hardhat");

async function main() {
    console.log("Deploying contracts...");

    const SLAContract = await hre.ethers.getContractFactory("SLAContract");
    const sla = await SLAContract.deploy();
    await sla.waitForDeployment();
    console.log(`SLAContract deployed to: ${await sla.getAddress()}`);

    const EvidenceVault = await hre.ethers.getContractFactory("EvidenceVault");
    const vault = await EvidenceVault.deploy();
    await vault.waitForDeployment();
    console.log(`EvidenceVault deployed to: ${await vault.getAddress()}`);

    const DisputeRegistry = await hre.ethers.getContractFactory("DisputeRegistry");
    const registry = await DisputeRegistry.deploy();
    await registry.waitForDeployment();
    console.log(`DisputeRegistry deployed to: ${await registry.getAddress()}`);

    const DisputeResolution = await hre.ethers.getContractFactory("DisputeResolution");
    const resolution = await DisputeResolution.deploy(
        await sla.getAddress(),
        await vault.getAddress(),
        await registry.getAddress()
    );
    await resolution.waitForDeployment();
    console.log(`DisputeResolution deployed to: ${await resolution.getAddress()}`);

    await vault.setResolution(await resolution.getAddress());
    console.log("Bound EvidenceVault to DisputeResolution");

    // Set up roles
    const RESOLUTION_ROLE = await registry.RESOLUTION_ROLE();
    await registry.grantRole(RESOLUTION_ROLE, await resolution.getAddress());
    console.log("Granted RESOLUTION_ROLE to DisputeResolution");

    console.log("Deployment complete.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
