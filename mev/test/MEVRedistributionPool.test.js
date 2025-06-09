const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("MEVRedistributionPool", function () {
  let pool;
  let owner;
  let validator1;
  let validator2;
  let proposer;
  let otherAccount;
  
  const EPOCH_LENGTH = 600; // 10 minutes
  
  beforeEach(async function () {
    [owner, validator1, validator2, proposer, otherAccount] = await ethers.getSigners();
    
    const MEVRedistributionPool = await ethers.getContractFactory("MEVRedistributionPool");
    pool = await MEVRedistributionPool.deploy(EPOCH_LENGTH);
    await pool.waitForDeployment();
  });
  
  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      expect(await pool.owner()).to.equal(owner.address);
    });
    
    it("Should set the correct epoch length", async function () {
      expect(await pool.EPOCH_LENGTH()).to.equal(EPOCH_LENGTH);
    });
  });
  
  describe("Surplus Deposit", function () {
    it("Should allow surplus deposits", async function () {
      const depositAmount = ethers.parseEther("1.0");
      const currentEpoch = await pool.currentEpoch();
      
      await expect(pool.connect(proposer).depositSurplus({ value: depositAmount }))
        .to.emit(pool, "SurplusDeposited")
        .withArgs(proposer.address, depositAmount, currentEpoch);
        
      expect(await pool.poolOfEpoch(currentEpoch)).to.equal(depositAmount);
    });
    
    it("Should reject zero value deposits", async function () {
      await expect(pool.connect(proposer).depositSurplus({ value: 0 }))
        .to.be.revertedWith("no value");
    });
    
    it("Should accumulate multiple deposits in same epoch", async function () {
      const deposit1 = ethers.parseEther("1.0");
      const deposit2 = ethers.parseEther("0.5");
      const currentEpoch = await pool.currentEpoch();
      
      await pool.connect(proposer).depositSurplus({ value: deposit1 });
      await pool.connect(proposer).depositSurplus({ value: deposit2 });
      
      expect(await pool.poolOfEpoch(currentEpoch)).to.equal(deposit1 + deposit2);
    });
  });
  
  describe("Stake Updates", function () {
    it("Should allow owner to update validator stakes", async function () {
      const newStake = ethers.parseEther("32");
      const currentEpoch = await pool.currentEpoch();
      
      await expect(pool.updateStake(validator1.address, newStake))
        .to.emit(pool, "StakeUpdated")
        .withArgs(validator1.address, newStake, currentEpoch);
        
      expect(await pool.stakeOf(validator1.address)).to.equal(newStake);
    });
    
    it("Should reject stake updates from non-owner", async function () {
      const newStake = ethers.parseEther("32");
      
      await expect(pool.connect(otherAccount).updateStake(validator1.address, newStake))
        .to.be.revertedWith("not authorized");
    });
    
    it("Should correctly update total stake", async function () {
      const stake1 = ethers.parseEther("32");
      const stake2 = ethers.parseEther("64");
      const currentEpoch = await pool.currentEpoch();
      
      await pool.updateStake(validator1.address, stake1);
      await pool.updateStake(validator2.address, stake2);
      
      expect(await pool.totalStakeAtEpoch(currentEpoch)).to.equal(stake1 + stake2);
    });
  });
  
  describe("Distribution", function () {
    beforeEach(async function () {
      // Setup: deposit surplus and set stakes
      const depositAmount = ethers.parseEther("10");
      await pool.connect(proposer).depositSurplus({ value: depositAmount });
      
      await pool.updateStake(validator1.address, ethers.parseEther("32"));
      await pool.updateStake(validator2.address, ethers.parseEther("64"));
    });
    
    it("Should not allow distribution for current epoch", async function () {
      const currentEpoch = await pool.currentEpoch();
      
      await expect(pool.distribute(currentEpoch))
        .to.be.revertedWith("epoch not finished");
    });
    
    it("Should allow distribution after epoch ends", async function () {
      const currentEpoch = await pool.currentEpoch();
      const poolAmount = await pool.poolOfEpoch(currentEpoch);
      
      // Move to next epoch
      await time.increase(EPOCH_LENGTH);
      
      await expect(pool.distribute(currentEpoch))
        .to.emit(pool, "RewardsDistributed")
        .withArgs(poolAmount, currentEpoch);
        
      expect(await pool.poolOfEpoch(currentEpoch)).to.equal(0);
    });
    
    it("Should prevent double distribution", async function () {
      const currentEpoch = await pool.currentEpoch();
      
      await time.increase(EPOCH_LENGTH);
      await pool.distribute(currentEpoch);
      
      await expect(pool.distribute(currentEpoch))
        .to.be.revertedWith("already distributed");
    });
  });
  
  describe("Claiming Rewards", function () {
    let epoch0;
    const depositAmount = ethers.parseEther("10");
    const stake1 = ethers.parseEther("30");
    const stake2 = ethers.parseEther("70");
    
    beforeEach(async function () {
      epoch0 = await pool.currentEpoch();
      
      // Setup stakes
      await pool.updateStake(validator1.address, stake1);
      await pool.updateStake(validator2.address, stake2);
      
      // Deposit surplus
      await pool.connect(proposer).depositSurplus({ value: depositAmount });
      
      // Move to next epoch and distribute
      await time.increase(EPOCH_LENGTH);
      await pool.distribute(epoch0);
    });
    
    it("Should not allow claiming from ongoing epoch", async function () {
      const currentEpoch = await pool.currentEpoch();
      
      await expect(pool.connect(validator1).claim(currentEpoch))
        .to.be.revertedWith("epoch ongoing");
    });
    
    it("Should distribute rewards proportionally to stake", async function () {
      const totalStake = stake1 + stake2;
      const expectedReward1 = (depositAmount * stake1) / totalStake;
      const expectedReward2 = (depositAmount * stake2) / totalStake;
      
      const balanceBefore1 = await ethers.provider.getBalance(validator1.address);
      const balanceBefore2 = await ethers.provider.getBalance(validator2.address);
      
      // Validator1 claims
      const tx1 = await pool.connect(validator1).claim(epoch0);
      const receipt1 = await tx1.wait();
      const gasUsed1 = receipt1.gasUsed * receipt1.gasPrice;
      
      // Validator2 claims
      const tx2 = await pool.connect(validator2).claim(epoch0);
      const receipt2 = await tx2.wait();
      const gasUsed2 = receipt2.gasUsed * receipt2.gasPrice;
      
      const balanceAfter1 = await ethers.provider.getBalance(validator1.address);
      const balanceAfter2 = await ethers.provider.getBalance(validator2.address);
      
      // Check rewards (accounting for gas)
      expect(balanceAfter1 - balanceBefore1 + gasUsed1).to.be.closeTo(expectedReward1, ethers.parseEther("0.001"));
      expect(balanceAfter2 - balanceBefore2 + gasUsed2).to.be.closeTo(expectedReward2, ethers.parseEther("0.001"));
    });
    
    it("Should emit RewardClaimed event", async function () {
      await expect(pool.connect(validator1).claim(epoch0))
        .to.emit(pool, "RewardClaimed");
    });
    
    it("Should handle validators with zero stake", async function () {
      await expect(pool.connect(otherAccount).claim(epoch0))
        .to.be.revertedWith("no reward");
    });
  });
  
  describe("Batch Claiming", function () {
    it("Should allow claiming multiple epochs at once", async function () {
      // Setup multiple epochs with deposits
      const epochs = [];
      
      for (let i = 0; i < 3; i++) {
        const currentEpoch = await pool.currentEpoch();
        epochs.push(currentEpoch);
        
        await pool.updateStake(validator1.address, ethers.parseEther("32"));
        await pool.connect(proposer).depositSurplus({ value: ethers.parseEther("1") });
        
        await time.increase(EPOCH_LENGTH);
        await pool.distribute(currentEpoch);
      }
      
      // Claim all epochs at once
      await expect(pool.connect(validator1).claimMany(epochs))
        .to.emit(pool, "RewardClaimed");
    });
  });
  
  describe("View Functions", function () {
    it("Should correctly calculate current epoch", async function () {
      const epoch0 = await pool.currentEpoch();
      
      await time.increase(EPOCH_LENGTH);
      const epoch1 = await pool.currentEpoch();
      
      expect(epoch1).to.equal(epoch0 + 1n);
    });
    
    it("Should return correct weight", async function () {
      const stake = ethers.parseEther("32");
      await pool.updateStake(validator1.address, stake);
      
      expect(await pool.weightOf(validator1.address)).to.equal(stake);
    });
    
    it("Should estimate claim correctly", async function () {
      const epoch = await pool.currentEpoch();
      const stake = ethers.parseEther("32");
      const deposit = ethers.parseEther("10");
      
      await pool.updateStake(validator1.address, stake);
      await pool.connect(proposer).depositSurplus({ value: deposit });
      
      await time.increase(EPOCH_LENGTH);
      await pool.distribute(epoch);
      
      const estimate = await pool.estimateClaim(validator1.address, epoch);
      expect(estimate).to.equal(deposit); // Only validator, gets all rewards
    });
  });
});